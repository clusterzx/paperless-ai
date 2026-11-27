/**
 * Exports of the built-in archive (docs/standalone/migration.md §5):
 *
 * - `ngx`: the format of Paperless-ngx's `document_exporter` (manifest.json with the model objects,
 *   the original files, archived PDFs), so `document_importer` reads it into a fresh Paperless-ngx.
 * - `plain`: folders library/correspondent/year/ with the files named after their titles, plus
 *   metadata.json and metadata.csv – readable without any software.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { BlobStore } from '../archive/blobs.js';
import { extensionFor } from '../archive/files.js';
import type { ExportResult } from '../../shared/migration.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'export' });

/** Paperless-ngx version whose `document_importer` the manifest is written for. */
export const NGX_EXPORT_VERSION = '2.20.0';

interface DocRow {
  id: number;
  library_id: number;
  title: string;
  created: string | null;
  added: string;
  modified: string;
  correspondent_id: number | null;
  document_type_id: number | null;
  storage_path_id: number | null;
  archive_serial_number: number | null;
  owner_id: number | null;
  current_version: number;
  original_filename: string | null;
  mime_type: string;
  page_count: number | null;
}

interface FileRow {
  kind: 'original' | 'archive';
  blob_sha256: string;
  original_filename: string | null;
  mime_type: string;
  size: number;
}

/** File system safe name (keeps letters of all languages). */
export function safeName(s: string, max = 120): string {
  const cleaned = [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, max)
    .trim();
  return cleaned || 'untitled';
}

/**
 * One CSV cell. A text that a spreadsheet would run as a formula (=, +, -, @ at the start – a title
 * from a document could be "=HYPERLINK(…)") gets a leading apostrophe; plain numbers stay as they are.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function copyBlob(blobs: BlobStore, sha: string, target: string, algorithm: ExportChecksums = 'sha256'): Promise<{ bytes: number; checksum: string }> {
  const data = await blobs.read(sha);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return { bytes: data.length, checksum: createHash(algorithm).update(data).digest('hex') };
}

/** A file name not used yet in this directory. */
function unique(dir: string, base: string, ext: string, used: Set<string>): string {
  let name = `${base}.${ext}`;
  for (let i = 2; used.has(path.join(dir, name).toLowerCase()); i++) name = `${base} (${i}).${ext}`;
  used.add(path.join(dir, name).toLowerCase());
  return name;
}

/**
 * Checksums in the Paperless-ngx manifest: current Paperless-ngx computes SHA-256, older versions MD5.
 * The importer stores them as they are; Paperless-ngx's sanity checker then compares them with the files.
 */
export type ExportChecksums = 'sha256' | 'md5';

export async function exportArchive(
  ctx: AppContext,
  blobs: BlobStore,
  opts: { format: 'ngx' | 'plain'; directory: string; libraryIds: number[] | null; checksums?: ExportChecksums },
): Promise<ExportResult> {
  const db = ctx.db;
  const dir = path.resolve(opts.directory);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error(`The target directory is not empty: ${dir}`);
  // The libraries as a bound parameter (JSON array), never as part of the SQL text.
  const docs = (
    opts.libraryIds
      ? db.prepare('SELECT * FROM lib_documents WHERE deleted_at IS NULL AND library_id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify(opts.libraryIds.map(Number)))
      : db.prepare('SELECT * FROM lib_documents WHERE deleted_at IS NULL ORDER BY id').all()
  ) as DocRow[];
  const fileOf = db.prepare('SELECT kind, blob_sha256, original_filename, mime_type, size FROM lib_document_files WHERE document_id = ? AND version = ?');
  const textOf = db.prepare('SELECT text FROM lib_document_text WHERE document_id = ? AND version = ?');
  const tagsOf = db.prepare('SELECT tag_id FROM lib_document_tags WHERE document_id = ? ORDER BY tag_id');
  const fieldsOf = db.prepare('SELECT v.*, f.data_type, f.name, f.extra FROM lib_custom_field_values v JOIN lib_custom_fields f ON f.id = v.field_id WHERE v.document_id = ?');
  const libs = new Set(docs.map((d) => d.library_id));
  const inLibs = (table: string) => db.prepare(`SELECT * FROM ${table} WHERE library_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify([...libs])) as Record<string, unknown>[];
  const tags = inLibs('lib_tags');
  const correspondents = inLibs('lib_correspondents');
  const types = inLibs('lib_document_types');
  const storagePaths = inLibs('lib_storage_paths');
  const fields = inLibs('lib_custom_fields');
  const name = (rows: Record<string, unknown>[], id: number | null) => (id == null ? null : ((rows.find((r) => r.id === id)?.name as string | undefined) ?? null));
  let files = 0;
  let bytes = 0;

  if (opts.format === 'plain') {
    const used = new Set<string>();
    const meta: Record<string, unknown>[] = [];
    for (const d of docs) {
      const f = fileOf.all(d.id, d.current_version) as FileRow[];
      const original = f.find((x) => x.kind === 'original');
      if (!original) continue;
      const lib = ctx.repos.libraries.get(d.library_id)?.name ?? `Library ${d.library_id}`;
      const corr = name(correspondents, d.correspondent_id) ?? 'No correspondent';
      const year = d.created?.slice(0, 4) ?? 'No date';
      const rel = path.join(safeName(lib), safeName(corr), year);
      const ext = path.extname(original.original_filename ?? '').slice(1) || extensionFor(original.mime_type);
      const file = unique(rel, safeName(`${d.created ?? ''} ${d.title}`.trim()), ext, used);
      const c = await copyBlob(blobs, original.blob_sha256, path.join(dir, rel, file));
      files++;
      bytes += c.bytes;
      meta.push({
        id: d.id,
        file: path.join(rel, file).split(path.sep).join('/'),
        title: d.title,
        created: d.created,
        added: d.added,
        library: lib,
        correspondent: name(correspondents, d.correspondent_id),
        document_type: name(types, d.document_type_id),
        storage_path: name(storagePaths, d.storage_path_id),
        tags: (tagsOf.all(d.id) as { tag_id: number }[]).map((t) => name(tags, t.tag_id)).filter(Boolean),
        archive_serial_number: d.archive_serial_number,
        custom_fields: Object.fromEntries(
          (fieldsOf.all(d.id) as { name: string; value_text: string | null; value_num: number | null; value_date: string | null; value_json: string | null }[]).map((v) => [
            v.name,
            v.value_date ?? v.value_num ?? v.value_text ?? (v.value_json ? JSON.parse(v.value_json) : null),
          ]),
        ),
        original_filename: original.original_filename,
        sha256: original.blob_sha256,
        text: (textOf.get(d.id, d.current_version) as { text: string } | undefined)?.text ?? '',
      });
    }
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
    const cols = ['id', 'file', 'title', 'created', 'added', 'library', 'correspondent', 'document_type', 'storage_path', 'tags', 'archive_serial_number', 'original_filename'];
    fs.writeFileSync(path.join(dir, 'metadata.csv'), `\uFEFF${[cols.join(','), ...meta.map((m) => cols.map((c) => csvCell(m[c])).join(','))].join('\n')}\n`);
    log.info(`Plain export: ${files} file(s) to ${dir}`);
    return { format: 'plain', directory: dir, documents: meta.length, files, bytes };
  }

  // ------------------------------------------------------------ Paperless-ngx exporter format
  const manifest: Record<string, unknown>[] = [];
  const iso = (ms: number | string) => new Date(ms).toISOString();
  const users = ctx.repos.users.list();
  const ownerOf = (id: number | null) => (id !== null && users.some((u) => u.id === id) ? id : null);
  for (const u of users) {
    manifest.push({
      model: 'auth.user',
      pk: u.id,
      fields: {
        password: '!',
        last_login: null,
        is_superuser: u.role === 'admin',
        username: u.username,
        first_name: u.display_name ?? '',
        last_name: '',
        email: u.email ?? '',
        is_staff: u.role === 'admin',
        is_active: !u.disabled_at,
        date_joined: iso(u.created_at),
        groups: [],
        user_permissions: [],
      },
    });
  }
  // Names are unique per library here, but global in Paperless-ngx: the same name of two libraries becomes one object.
  const merged = (rows: Record<string, unknown>[]) => {
    const byName = new Map<string, number>();
    const map = new Map<number, number>();
    for (const r of rows) {
      const key = String(r.name_norm);
      if (!byName.has(key)) byName.set(key, r.id as number);
      map.set(r.id as number, byName.get(key)!);
    }
    return { firsts: rows.filter((r) => byName.get(String(r.name_norm)) === r.id), map };
  };
  const matchless = { match: '', matching_algorithm: 0, is_insensitive: true, owner: null };
  const mc = merged(correspondents);
  for (const r of mc.firsts) manifest.push({ model: 'documents.correspondent', pk: r.id, fields: { ...matchless, name: r.name } });
  const mt = merged(types);
  for (const r of mt.firsts) manifest.push({ model: 'documents.documenttype', pk: r.id, fields: { ...matchless, name: r.name } });
  const mg = merged(tags);
  for (const r of mg.firsts) manifest.push({ model: 'documents.tag', pk: r.id, fields: { ...matchless, name: r.name, color: r.color ?? '#a6cee3', is_inbox_tag: Boolean(r.is_inbox) } });
  const ms = merged(storagePaths);
  for (const r of ms.firsts) manifest.push({ model: 'documents.storagepath', pk: r.id, fields: { ...matchless, name: r.name, path: r.template || '{{ created_year }}/{{ title }}' } });
  const mf = merged(fields);
  for (const r of mf.firsts) manifest.push({ model: 'documents.customfield', pk: r.id, fields: { name: r.name, data_type: r.data_type, extra_data: JSON.parse(String(r.extra || '{}')), created: iso(r.created_at as number) } });

  let instance = 0;
  for (const d of docs) {
    const f = fileOf.all(d.id, d.current_version) as FileRow[];
    const original = f.find((x) => x.kind === 'original');
    if (!original) continue;
    const ext = path.extname(original.original_filename ?? '').slice(1) || extensionFor(original.mime_type);
    const base = `${String(d.id).padStart(7, '0')}`;
    const fileName = `${base}.${ext}`;
    const o = await copyBlob(blobs, original.blob_sha256, path.join(dir, fileName), opts.checksums);
    files++;
    bytes += o.bytes;
    const record: Record<string, unknown> = {
      model: 'documents.document',
      pk: d.id,
      fields: {
        owner: ownerOf(d.owner_id),
        correspondent: d.correspondent_id !== null ? mc.map.get(d.correspondent_id) : null,
        storage_path: d.storage_path_id !== null ? ms.map.get(d.storage_path_id) : null,
        title: d.title,
        document_type: d.document_type_id !== null ? mt.map.get(d.document_type_id) : null,
        content: (textOf.get(d.id, d.current_version) as { text: string } | undefined)?.text ?? '',
        mime_type: original.mime_type,
        checksum: o.checksum,
        archive_checksum: null,
        page_count: d.page_count,
        created: d.created ?? d.added.slice(0, 10),
        modified: d.modified,
        storage_type: 'unencrypted',
        added: d.added,
        filename: fileName,
        archive_filename: null,
        original_filename: original.original_filename ?? fileName,
        archive_serial_number: d.archive_serial_number,
        tags: [...new Set((tagsOf.all(d.id) as { tag_id: number }[]).map((t) => mg.map.get(t.tag_id)))],
        deleted_at: null,
        restored_at: null,
        transaction_id: null,
      },
      __exported_file_name__: fileName,
    };
    const archive = f.find((x) => x.kind === 'archive');
    if (archive) {
      const a = await copyBlob(blobs, archive.blob_sha256, path.join(dir, `${base}-archive.pdf`), opts.checksums);
      files++;
      bytes += a.bytes;
      (record.fields as Record<string, unknown>).archive_checksum = a.checksum;
      (record.fields as Record<string, unknown>).archive_filename = `${base}-archive.pdf`;
      record.__exported_archive_name__ = `${base}-archive.pdf`;
    }
    manifest.push(record);
    for (const v of fieldsOf.all(d.id) as { field_id: number; data_type: string; value_text: string | null; value_num: number | null; value_date: string | null; value_json: string | null }[]) {
      const value: Record<string, unknown> = {};
      switch (v.data_type) {
        case 'string':
          value.value_text = v.value_text;
          break;
        case 'longtext':
          value.value_long_text = v.value_text;
          break;
        case 'url':
          value.value_url = v.value_text;
          break;
        case 'date':
          value.value_date = v.value_date;
          break;
        case 'boolean':
          value.value_bool = v.value_num === null ? null : v.value_num === 1;
          break;
        case 'integer':
          value.value_int = v.value_num;
          break;
        case 'float':
          value.value_float = v.value_num;
          break;
        case 'monetary': {
          const currency = v.value_json ? (JSON.parse(v.value_json) as { currency?: string }).currency : undefined;
          value.value_monetary = v.value_num === null ? null : `${currency ?? ''}${v.value_num.toFixed(2)}`;
          break;
        }
        case 'select':
          value.value_select = v.value_text;
          break;
        case 'documentlink':
          value.value_document_ids = v.value_json ? JSON.parse(v.value_json) : null;
          break;
        default:
          value.value_text = v.value_text;
      }
      manifest.push({ model: 'documents.customfieldinstance', pk: ++instance, fields: { created: iso(Date.now()), document: d.id, field: mf.map.get(v.field_id), ...value } });
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ version: NGX_EXPORT_VERSION }, null, 2));
  log.info(`Paperless-ngx export: ${docs.length} document(s), ${files} file(s) to ${dir}`);
  return { format: 'ngx', directory: dir, documents: docs.length, files, bytes };
}
