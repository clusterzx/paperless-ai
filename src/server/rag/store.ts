/**
 * Persistence of the RAG index in SQLite: documents, passages (chunks),
 * embeddings (BLOB) and a contentless FTS5 index for BM25 keyword search.
 */
import type { Db } from '../db/database.js';
import { fromBlob, toBlob } from './vectorIndex.js';

export interface RagDocumentMeta {
  id: number;
  modified: string | null;
  contentHash: string;
  title: string;
  correspondent: string | null;
  documentType: string | null;
  tags: string[];
  created: string | null;
}

export interface StoredChunk {
  id: number;
  documentId: number;
  idx: number;
  text: string;
}

export interface ChunkWithMeta extends StoredChunk {
  title: string;
  correspondent: string | null;
  documentType: string | null;
  tags: string[];
  created: string | null;
  chunkCount: number;
}

/** Text describing the document, indexed with higher weight and prepended for embeddings. */
export function metaLine(d: Pick<RagDocumentMeta, 'title' | 'correspondent' | 'documentType' | 'tags' | 'created'>): string {
  const parts = [`Title: ${d.title}`];
  if (d.correspondent) parts.push(`From: ${d.correspondent}`);
  if (d.documentType) parts.push(`Type: ${d.documentType}`);
  if (d.created) parts.push(`Date: ${d.created}`);
  if (d.tags.length) parts.push(`Tags: ${d.tags.join(', ')}`);
  return parts.join(' | ');
}

export class RagStore {
  /** Results of aggregate queries, dropped on every change (status is polled frequently). */
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly db: Db) {}

  private cached<T>(key: string, compute: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, compute());
    return this.cache.get(key) as T;
  }

  /** id → modified/hash/meta of all indexed documents (for change detection). */
  indexedDocuments(): Map<number, { modified: string | null; meta: string; contentHash: string }> {
    const rows = this.db
      .prepare('SELECT id, modified, content_hash, title, correspondent, document_type, tags, created FROM rag_documents')
      .all() as { id: number; modified: string | null; content_hash: string; title: string; correspondent: string | null; document_type: string | null; tags: string; created: string | null }[];
    return new Map(
      rows.map((r) => [
        r.id,
        {
          modified: r.modified,
          contentHash: r.content_hash,
          meta: metaLine({ title: r.title, correspondent: r.correspondent, documentType: r.document_type, tags: splitTags(r.tags), created: r.created }),
        },
      ]),
    );
  }

  /** Replace a document and its passages. Returns the ids of the new chunks. */
  upsertDocument(doc: RagDocumentMeta, chunks: string[]): number[] {
    this.cache.clear();
    return this.db.transaction(() => {
      this.deleteDocumentRows(doc.id);
      this.db
        .prepare(
          `INSERT INTO rag_documents (id, modified, content_hash, title, correspondent, document_type, tags, created, chunk_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(doc.id, doc.modified, doc.contentHash, doc.title, doc.correspondent, doc.documentType, doc.tags.join('\u001f'), doc.created, chunks.length, Date.now());
      const insertChunk = this.db.prepare('INSERT INTO rag_chunks (document_id, idx, text) VALUES (?, ?, ?)');
      const insertFts = this.db.prepare('INSERT INTO rag_fts (rowid, meta, body) VALUES (?, ?, ?)');
      const meta = metaLine(doc);
      const ids: number[] = [];
      chunks.forEach((text, idx) => {
        const id = Number(insertChunk.run(doc.id, idx, text).lastInsertRowid);
        insertFts.run(id, meta, text);
        ids.push(id);
      });
      return ids;
    })();
  }

  private deleteDocumentRows(documentId: number): number[] {
    const ids = (this.db.prepare('SELECT id FROM rag_chunks WHERE document_id = ?').all(documentId) as { id: number }[]).map((r) => r.id);
    const delFts = this.db.prepare('DELETE FROM rag_fts WHERE rowid = ?');
    for (const id of ids) delFts.run(id);
    this.db.prepare('DELETE FROM rag_chunks WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM rag_documents WHERE id = ?').run(documentId);
    return ids;
  }

  deleteDocument(documentId: number): number[] {
    this.cache.clear();
    return this.db.transaction(() => this.deleteDocumentRows(documentId))();
  }

  clear(): void {
    this.cache.clear();
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM rag_chunks; DELETE FROM rag_documents; DELETE FROM rag_fts;`);
    })();
  }

  /** Chunks without an embedding (to be embedded), with the text used for embedding. */
  pendingEmbeddings(limit: number): { id: number; documentId: number; text: string }[] {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id AS documentId, c.text, d.title, d.correspondent, d.document_type, d.tags, d.created
         FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id
         WHERE c.embedding IS NULL ORDER BY c.id LIMIT ?`,
      )
      .all(limit)
      .map((r) => {
        const row = r as { id: number; documentId: number; text: string; title: string; correspondent: string | null; document_type: string | null; tags: string; created: string | null };
        const meta = metaLine({ title: row.title, correspondent: row.correspondent, documentType: row.document_type, tags: splitTags(row.tags), created: row.created });
        return { id: row.id, documentId: row.documentId, text: `${meta}\n${row.text}` };
      });
  }

  countPendingEmbeddings(): number {
    return this.cached('pending', () => (this.db.prepare('SELECT COUNT(*) AS c FROM rag_chunks WHERE embedding IS NULL').get() as { c: number }).c);
  }

  saveEmbeddings(items: { id: number; vector: Float32Array }[]): void {
    this.cache.delete('pending');
    const stmt = this.db.prepare('UPDATE rag_chunks SET embedding = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const it of items) stmt.run(toBlob(it.vector), it.id);
    })();
  }

  clearEmbeddings(): void {
    this.cache.clear();
    this.db.prepare('UPDATE rag_chunks SET embedding = NULL').run();
  }

  /** Stored embeddings with an id above `afterId`, in id order (pages for building the in-memory index). */
  embeddingsAfter(afterId: number, limit: number): { id: number; documentId: number; vector: Float32Array }[] {
    const rows = this.db
      .prepare('SELECT id, document_id AS documentId, embedding FROM rag_chunks WHERE id > ? AND embedding IS NOT NULL ORDER BY id LIMIT ?')
      .all(afterId, limit) as { id: number; documentId: number; embedding: Buffer }[];
    return rows.map((row) => ({ id: row.id, documentId: row.documentId, vector: fromBlob(row.embedding) }));
  }

  embeddings(ids: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    const stmt = this.db.prepare('SELECT id, embedding FROM rag_chunks WHERE id = ? AND embedding IS NOT NULL');
    for (const id of ids) {
      const row = stmt.get(id) as { id: number; embedding: Buffer } | undefined;
      if (row) out.set(row.id, fromBlob(row.embedding));
    }
    return out;
  }

  /** BM25 keyword search. Lower bm25 = better; returned score is negated (higher = better). */
  ftsSearch(match: string, limit: number): { id: number; documentId: number; score: number }[] {
    try {
      return this.db
        .prepare(
          `SELECT f.rowid AS id, c.document_id AS documentId, -bm25(rag_fts, 2.0, 1.0) AS score
           FROM rag_fts f JOIN rag_chunks c ON c.id = f.rowid
           WHERE rag_fts MATCH ? ORDER BY bm25(rag_fts, 2.0, 1.0) LIMIT ?`,
        )
        .all(match, limit) as { id: number; documentId: number; score: number }[];
    } catch {
      return [];
    }
  }

  chunksWithMeta(ids: number[]): Map<number, ChunkWithMeta> {
    const out = new Map<number, ChunkWithMeta>();
    if (!ids.length) return out;
    const stmt = this.db.prepare(
      `SELECT c.id, c.document_id, c.idx, c.text, d.title, d.correspondent, d.document_type, d.tags, d.created, d.chunk_count
       FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id WHERE c.id = ?`,
    );
    for (const id of ids) {
      const r = stmt.get(id) as
        | { id: number; document_id: number; idx: number; text: string; title: string; correspondent: string | null; document_type: string | null; tags: string; created: string | null; chunk_count: number }
        | undefined;
      if (r) {
        out.set(r.id, {
          id: r.id,
          documentId: r.document_id,
          idx: r.idx,
          text: r.text,
          title: r.title,
          correspondent: r.correspondent,
          documentType: r.document_type,
          tags: splitTags(r.tags),
          created: r.created,
          chunkCount: r.chunk_count,
        });
      }
    }
    return out;
  }

  documentChunks(documentId: number): StoredChunk[] {
    return this.db
      .prepare('SELECT id, document_id AS documentId, idx, text FROM rag_chunks WHERE document_id = ? ORDER BY idx')
      .all(documentId) as StoredChunk[];
  }

  /** Documents matching metadata filters (used for soft boosts and hard filters). */
  documentsWhere(filter: {
    correspondents?: string[];
    documentTypes?: string[];
    years?: number[];
    months?: { year: number; month: number }[];
    from?: string;
    to?: string;
  }): { id: number; created: string | null }[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.correspondents?.length) {
      where.push(`correspondent COLLATE NOCASE IN (${filter.correspondents.map(() => '?').join(',')})`);
      params.push(...filter.correspondents);
    }
    if (filter.documentTypes?.length) {
      where.push(`document_type COLLATE NOCASE IN (${filter.documentTypes.map(() => '?').join(',')})`);
      params.push(...filter.documentTypes);
    }
    if (filter.years?.length) {
      // Created in that year, or about that year ("Lohnsteuerbescheinigung 2023" is issued in 2024).
      where.push(`(substr(created, 1, 4) IN (${filter.years.map(() => '?').join(',')}) OR ${filter.years.map(() => 'title LIKE ?').join(' OR ')})`);
      params.push(...filter.years.map(String), ...filter.years.map((y) => `%${y}%`));
    }
    if (filter.months?.length) {
      where.push(`substr(created, 1, 7) IN (${filter.months.map(() => '?').join(',')})`);
      params.push(...filter.months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`));
    }
    if (filter.from) {
      where.push('created >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      where.push('created <= ?');
      params.push(filter.to);
    }
    if (!where.length) return [];
    return this.db
      .prepare(`SELECT id, created FROM rag_documents WHERE ${where.join(' AND ')} ORDER BY created DESC LIMIT 500`)
      .all(...params) as { id: number; created: string | null }[];
  }

  /** A few document titles (helps the AI to guess the language of the archive). */
  sampleTitles(limit: number): string[] {
    return (this.db.prepare('SELECT title FROM rag_documents ORDER BY created DESC LIMIT ?').all(limit) as { title: string }[]).map((r) => r.title);
  }

  createdDates(ids: number[]): Map<number, string | null> {
    const stmt = this.db.prepare('SELECT created FROM rag_documents WHERE id = ?');
    return new Map(ids.map((id) => [id, (stmt.get(id) as { created: string | null } | undefined)?.created ?? null]));
  }

  /** Most recent documents (for "latest …" questions). */
  recentDocuments(limit: number): { id: number; created: string | null }[] {
    return this.db.prepare('SELECT id, created FROM rag_documents ORDER BY created DESC LIMIT ?').all(limit) as { id: number; created: string | null }[];
  }

  distinctValues(column: 'correspondent' | 'document_type'): string[] {
    return this.cached(`distinct:${column}`, () =>
      (this.db.prepare(`SELECT DISTINCT ${column} AS v FROM rag_documents WHERE ${column} IS NOT NULL AND ${column} != ''`).all() as { v: string }[]).map(
        (r) => r.v,
      ),
    );
  }

  stats(): { documents: number; chunks: number; embedded: number } {
    // Counts from the small documents table and the pending-embeddings index – never a scan over all passages.
    const { documents, chunks } = this.cached('counts', () => {
      const r = this.db.prepare('SELECT COUNT(*) AS d, COALESCE(SUM(chunk_count), 0) AS c FROM rag_documents').get() as { d: number; c: number };
      return { documents: r.d, chunks: r.c };
    });
    return { documents, chunks, embedded: chunks - this.countPendingEmbeddings() };
  }
}

export function splitTags(value: string): string[] {
  return value ? value.split('\u001f').filter(Boolean) : [];
}
