/**
 * Tags, correspondents, document types, storage paths and custom fields of one library of the
 * built-in archive (the MetadataSource the MetadataCache works on).
 */
import type { Db } from '../db/database.js';
import { ArchiveError, type ArchiveUser, type Correspondent, type CustomField, type CustomFieldType, type DocumentType, type MetadataKind, type MetadataSource, type StoragePath, type Tag } from '../backend/types.js';
import { cleanName, normalizeName } from '../backend/metadata.js';
import { parseOptions } from './fields.js';

export const METADATA_TABLE: Record<MetadataKind, string> = {
  tag: 'lib_tags',
  correspondent: 'lib_correspondents',
  documentType: 'lib_document_types',
  customField: 'lib_custom_fields',
};

const counter = (kind: string) => `COALESCE((SELECT c.count FROM lib_counters c WHERE c.library_id = m.library_id AND c.kind = '${kind}' AND c.item_id = m.id), 0)`;

/** Number of documents (not in the trash) per metadata object – kept by triggers (counters.ts). */
const COUNT_SQL: Record<MetadataKind, string> = {
  tag: counter('tag'),
  correspondent: counter('correspondent'),
  documentType: counter('document_type'),
  customField: `(SELECT COUNT(*) FROM lib_custom_field_values v JOIN lib_documents d ON d.id = v.document_id AND d.deleted_at IS NULL WHERE v.field_id = m.id)`,
};

function conflict(name: string): ArchiveError {
  return new ArchiveError(`"${name}" exists already`, 409, 'exists');
}

function isUnique(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export class LibraryMetadataSource implements MetadataSource {
  constructor(
    private readonly db: Db,
    readonly libraryId: number,
  ) {}

  private list<T>(kind: MetadataKind, extra = ''): T[] {
    return this.db
      .prepare(`SELECT m.*${extra}, ${COUNT_SQL[kind]} AS document_count FROM ${METADATA_TABLE[kind]} m WHERE m.library_id = ? ORDER BY m.name COLLATE NOCASE`)
      .all(this.libraryId) as T[];
  }

  async tags(): Promise<Tag[]> {
    return this.list<{ id: number; name: string; color: string | null; parent_id: number | null; is_inbox: number; document_count: number }>('tag').map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? undefined,
      parent: t.parent_id,
      is_inbox_tag: Boolean(t.is_inbox),
      document_count: t.document_count,
      library_id: this.libraryId,
    }));
  }

  async correspondents(): Promise<Correspondent[]> {
    return this.list<{ id: number; name: string; document_count: number }>('correspondent').map((c) => ({ id: c.id, name: c.name, document_count: c.document_count, library_id: this.libraryId }));
  }

  async documentTypes(): Promise<DocumentType[]> {
    return this.list<{ id: number; name: string; document_count: number }>('documentType').map((c) => ({ id: c.id, name: c.name, document_count: c.document_count, library_id: this.libraryId }));
  }

  async customFields(): Promise<CustomField[]> {
    return this.list<{ id: number; name: string; data_type: CustomFieldType; extra: string; document_count: number }>('customField').map((f) => {
      const extra = JSON.parse(f.extra || '{}') as { default_currency?: string | null };
      return {
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        extra_data: { select_options: parseOptions(f.extra), default_currency: extra.default_currency ?? null },
        document_count: f.document_count,
        library_id: this.libraryId,
      };
    });
  }

  async storagePaths(): Promise<StoragePath[]> {
    return (this.db.prepare('SELECT id, name, template FROM lib_storage_paths WHERE library_id = ? ORDER BY name COLLATE NOCASE').all(this.libraryId) as { id: number; name: string; template: string }[]).map(
      (s) => ({ id: s.id, name: s.name, path: s.template, library_id: this.libraryId }),
    );
  }

  async users(): Promise<ArchiveUser[]> {
    return this.db.prepare('SELECT id, username FROM users ORDER BY username COLLATE NOCASE').all() as ArchiveUser[];
  }

  private insert(kind: MetadataKind, name: string, extraCols: Record<string, unknown> = {}): number {
    const clean = cleanName(name);
    if (!clean) throw new ArchiveError('The name is empty', 400, 'invalid_name');
    const cols = ['library_id', 'name', 'name_norm', 'created_at', ...Object.keys(extraCols)];
    try {
      return Number(
        this.db
          .prepare(`INSERT INTO ${METADATA_TABLE[kind]} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(this.libraryId, clean, normalizeName(clean), Date.now(), ...Object.values(extraCols)).lastInsertRowid,
      );
    } catch (err) {
      if (isUnique(err)) throw conflict(clean);
      throw err;
    }
  }

  async createTag(name: string, extra: Partial<Tag> = {}): Promise<Tag> {
    const id = this.insert('tag', name, extra.color ? { color: extra.color } : {});
    return { id, name: cleanName(name), document_count: 0, library_id: this.libraryId };
  }

  async createCorrespondent(name: string): Promise<Correspondent> {
    return { id: this.insert('correspondent', name), name: cleanName(name), document_count: 0, library_id: this.libraryId };
  }

  async createDocumentType(name: string): Promise<DocumentType> {
    return { id: this.insert('documentType', name), name: cleanName(name), document_count: 0, library_id: this.libraryId };
  }

  async createCustomField(name: string, dataType: CustomFieldType, currency?: string): Promise<CustomField> {
    const extra = JSON.stringify({ select_options: [], default_currency: dataType === 'monetary' ? (currency ?? null) : null });
    const id = this.insert('customField', name, { data_type: dataType, extra });
    return { id, name: cleanName(name), data_type: dataType, extra_data: { select_options: [], default_currency: currency ?? null }, document_count: 0, library_id: this.libraryId };
  }
}
