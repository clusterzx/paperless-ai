/**
 * Cached view of Paperless metadata (tags, correspondents, document types,
 * custom fields) with race-free "get or create" helpers.
 */
import { logger } from '../logger.js';
import { PaperlessError, type PaperlessClient } from './client.js';
import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessCustomFieldType,
  PaperlessDocumentType,
  PaperlessTag,
} from './types.js';

const log = logger.child({ module: 'paperless' });

export interface MetadataSnapshot {
  tags: PaperlessTag[];
  correspondents: PaperlessCorrespondent[];
  documentTypes: PaperlessDocumentType[];
  customFields: PaperlessCustomField[];
  loadedAt: number;
}

export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export type Kind = 'tag' | 'correspondent' | 'documentType' | 'customField';

export interface ResolveResult {
  id: number | null;
  name: string;
  created: boolean;
}

export interface MetadataOptions {
  /** Create tags, correspondents and document types without owner (visible to all Paperless users). */
  shareCreated?: () => boolean;
}

export class PaperlessMetadata {
  private snap: MetadataSnapshot | null = null;
  private loading: Promise<MetadataSnapshot> | null = null;
  private readonly pending = new Map<string, Promise<ResolveResult>>();
  /** Lists the API user may not read (403): nothing is created there – it could exist already. */
  private readonly unreadable = new Set<Kind>();

  constructor(
    private readonly client: PaperlessClient,
    private readonly ttlMs = 60_000,
    private readonly opts: MetadataOptions = {},
  ) {}

  invalidate(): void {
    this.snap = null;
  }

  async snapshot(force = false): Promise<MetadataSnapshot> {
    if (!force && this.snap && Date.now() - this.snap.loadedAt < this.ttlMs) return this.snap;
    this.loading ??= (async () => {
      // Correspondents, document types and custom fields need their own view permission – don't
      // fail everything without it (the connection test reports the missing permissions).
      const optional = <T>(kind: Kind, label: string, load: () => Promise<T[]>) =>
        load().then(
          (items) => {
            this.unreadable.delete(kind);
            return items;
          },
          (err: unknown) => {
            const forbidden = err instanceof PaperlessError && err.status === 403;
            if (!forbidden && kind !== 'customField') throw err;
            if (forbidden) this.unreadable.add(kind);
            log.warn(`Could not load ${label}: ${err instanceof Error ? err.message : String(err)}`);
            return [] as T[];
          },
        );
      const [tags, correspondents, documentTypes, customFields] = await Promise.all([
        this.client.tags(),
        optional<PaperlessCorrespondent>('correspondent', 'correspondents', () => this.client.correspondents()),
        optional<PaperlessDocumentType>('documentType', 'document types', () => this.client.documentTypes()),
        optional<PaperlessCustomField>('customField', 'custom fields', () => this.client.customFields()),
      ]);
      this.snap = { tags, correspondents, documentTypes, customFields, loadedAt: Date.now() };
      return this.snap;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Synchronous lookups on the last snapshot (call snapshot() first). */
  get current(): MetadataSnapshot {
    return this.snap ?? { tags: [], correspondents: [], documentTypes: [], customFields: [], loadedAt: 0 };
  }

  tagName(id: number): string | undefined {
    return this.current.tags.find((t) => t.id === id)?.name;
  }

  correspondentName(id: number | null | undefined): string | null {
    if (id == null) return null;
    return this.current.correspondents.find((c) => c.id === id)?.name ?? null;
  }

  documentTypeName(id: number | null | undefined): string | null {
    if (id == null) return null;
    return this.current.documentTypes.find((d) => d.id === id)?.name ?? null;
  }

  private list(kind: Kind): { id: number; name: string }[] {
    const s = this.current;
    return kind === 'tag' ? s.tags : kind === 'correspondent' ? s.correspondents : kind === 'documentType' ? s.documentTypes : s.customFields;
  }

  private find(kind: Kind, name: string): { id: number; name: string } | undefined {
    const n = normalizeName(name);
    return this.list(kind).find((x) => normalizeName(x.name) === n);
  }

  private add(kind: Kind, item: { id: number; name: string }): void {
    if (!this.snap) return;
    const target = this.list(kind) as { id: number; name: string }[];
    if (!target.some((x) => x.id === item.id)) target.push(item);
  }

  /**
   * Find an object by name (case-insensitive) or create it when allowed.
   * Concurrent calls for the same name share one request.
   */
  private async resolve(
    kind: Kind,
    rawName: string,
    create: boolean,
    creator: (name: string) => Promise<{ id: number; name: string }>,
  ): Promise<ResolveResult> {
    const name = rawName.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!name) return { id: null, name, created: false };
    await this.snapshot();
    const existing = this.find(kind, name);
    if (existing) return { id: existing.id, name: existing.name, created: false };
    if (!create || this.unreadable.has(kind)) return { id: null, name, created: false };

    const key = `${kind}:${normalizeName(name)}`;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = (async (): Promise<ResolveResult> => {
      try {
        const created = await creator(name);
        this.add(kind, created);
        log.info(`Created ${kind} "${created.name}" (id ${created.id})`);
        return { id: created.id, name: created.name, created: true };
      } catch (err) {
        // Most likely created concurrently (unique constraint) – reload and look again.
        if (err instanceof PaperlessError && err.status === 400) {
          await this.snapshot(true);
          const found = this.find(kind, name);
          if (found) return { id: found.id, name: found.name, created: false };
        }
        throw err;
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** Body fields for created objects: without owner, Paperless makes them the API user's. */
  private ownership(): { owner?: null } {
    return this.opts.shareCreated?.() === false ? {} : { owner: null };
  }

  /** Whether the API user can read this list (false after a 403). */
  readable(kind: Kind): boolean {
    return !this.unreadable.has(kind);
  }

  resolveTag(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('tag', name, create, (n) => this.client.createTag(n, this.ownership()));
  }

  resolveCorrespondent(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('correspondent', name, create, (n) => this.client.createCorrespondent(n, this.ownership()));
  }

  resolveDocumentType(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('documentType', name, create, (n) => this.client.createDocumentType(n, this.ownership()));
  }

  resolveCustomField(name: string, create: boolean, type: PaperlessCustomFieldType = 'string', currency?: string): Promise<ResolveResult> {
    return this.resolve('customField', name, create, (n) => this.client.createCustomField(n, type, currency));
  }

  customField(id: number): PaperlessCustomField | undefined {
    return this.current.customFields.find((f) => f.id === id);
  }

  customFieldByName(name: string): PaperlessCustomField | undefined {
    return this.find('customField', name) as PaperlessCustomField | undefined;
  }

  /** Resolve many tag names at once. */
  async resolveTags(names: string[], create: boolean): Promise<{ ids: number[]; missing: string[]; created: string[] }> {
    const unique = [...new Map(names.filter((n) => typeof n === 'string' && n.trim()).map((n) => [normalizeName(n), n])).values()];
    const results = await Promise.all(unique.map((n) => this.resolveTag(n, create)));
    const ids: number[] = [];
    const missing: string[] = [];
    const created: string[] = [];
    results.forEach((r, i) => {
      if (r.id == null) missing.push(unique[i]);
      else {
        if (!ids.includes(r.id)) ids.push(r.id);
        if (r.created) created.push(r.name);
      }
    });
    return { ids, missing, created };
  }
}
