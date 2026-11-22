import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/database.js';
import { moveRagIndex, openIndexDatabase } from '../../src/server/db/indexDatabase.js';
import { RagStore } from '../../src/server/rag/store.js';
import { fromBlob, isQuantizedBlob } from '../../src/server/rag/vectorIndex.js';
import { buildFtsQuery, queryTerms } from '../../src/server/rag/text.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const hasTable = (db: ReturnType<typeof openDatabase>, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));

describe('index.db', () => {
  it('moves the search index out of the core database, converting embeddings to int8', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-index-'));
    dirs.push(dir);
    const core = openDatabase(path.join(dir, 'paperless-ai.db'));
    // An index as ≤ 4.4 left it: float32 embeddings in the core database (no library column).
    const vec = Float32Array.from({ length: 16 }, (_, i) => (i % 3) - 1 + i / 100);
    core
      .prepare(
        "INSERT INTO rag_documents (id, modified, content_hash, title, correspondent, document_type, tags, created, chunk_count, indexed_at) VALUES (7, '2024-01-01T00:00:00Z', 'h7', 'Stromrechnung', 'Stadtwerke', 'Rechnung', 'Energie', '2024-01-01', 2, 0)",
      )
      .run();
    const insChunk = core.prepare('INSERT INTO rag_chunks (document_id, idx, text, embedding) VALUES (7, ?, ?, ?)');
    insChunk.run(0, 'Abschlag für Strom im Januar', Buffer.from(vec.buffer));
    insChunk.run(1, 'Zählerstand 4711', Buffer.from(vec.buffer));

    const index = openIndexDatabase(path.join(dir, 'index.db'));
    moveRagIndex(core, index, dir);

    expect(hasTable(core, 'rag_documents')).toBe(false);
    expect(hasTable(core, 'rag_chunks')).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('pre-index-move-'))).toBe(true);

    const store = new RagStore(index);
    expect(store.stats()).toEqual({ documents: 1, chunks: 2, embedded: 2 });
    const blob = (index.prepare('SELECT embedding FROM rag_chunks LIMIT 1').get() as { embedding: Buffer }).embedding;
    expect(isQuantizedBlob(blob)).toBe(true);
    const back = fromBlob(blob);
    // Stored normalized (cosine similarity = dot product).
    const norm = Math.hypot(...vec);
    for (let i = 0; i < vec.length; i++) expect(back[i]).toBeCloseTo(vec[i] / norm, 2);
    // Full text (passages and meta line) is searchable again.
    expect(store.ftsSearch(buildFtsQuery(queryTerms('Zählerstand'))!, 5).map((h) => h.documentId)).toEqual([7]);
    expect(store.ftsSearch(buildFtsQuery(queryTerms('Stadtwerke'))!, 5)).toHaveLength(2);

    // A second start finds nothing to move and leaves the index alone.
    moveRagIndex(core, index, dir);
    expect(store.stats().chunks).toBe(2);
    core.close();
    index.close();
  });
});
