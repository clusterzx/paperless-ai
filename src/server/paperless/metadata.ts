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

type Kind = 'tag' | 'correspondent' | 'documentType' | 'customField';

export interface ResolveResult {
  id: number | null;
  name: string;
  created: boolean;
}

export class PaperlessMetadata {
  private snap: MetadataSnapshot | null = null;
  private loading: Promise<MetadataSnapshot> | null = null;
  private readonly pending = new Map<string, Promise<ResolveResult>>();

  constructor(
    private readonly client: PaperlessClient,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(): void {
    this.snap = null;
  }

  async snapshot(force = false): Promise<MetadataSnapshot> {
    if (!force && this.snap && Date.now() - this.snap.loadedAt < this.ttlMs) return this.snap;
    this.loading ??= (async () => {
      const [tags, correspondents, documentTypes, customFields] = await Promise.all([
        this.client.tags(),
        this.client.correspondents(),
        this.client.documentTypes(),
        this.client.customFields().catch((err) => {
          // Custom fields need an extra permission – don't fail everything without it.
          log.warn({ err }, 'Could not load custom fields');
          return [] as PaperlessCustomField[];
        }),
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
    if (!create) return { id: null, name, created: false };

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

  resolveTag(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('tag', name, create, (n) => this.client.createTag(n));
  }

  resolveCorrespondent(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('correspondent', name, create, (n) => this.client.createCorrespondent(n));
  }

  resolveDocumentType(name: string, create: boolean): Promise<ResolveResult> {
    return this.resolve('documentType', name, create, (n) => this.client.createDocumentType(n));
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
