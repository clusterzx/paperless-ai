import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../src/server/db/database.js';
import { checkCounters, rebuildCounters } from '../../src/server/archive/counters.js';

function setup() {
  const db = openDatabase(':memory:');
  const now = Date.now();
  db.prepare("INSERT INTO libraries (id, name, created_at) VALUES (1, 'A', ?), (2, 'B', ?)").run(now, now);
  for (const lib of [1, 2]) {
    db.prepare("INSERT INTO lib_correspondents (id, library_id, name, name_norm, created_at) VALUES (?, ?, 'C', 'c', ?)").run(lib * 10, lib, now);
    db.prepare("INSERT INTO lib_document_types (id, library_id, name, name_norm, created_at) VALUES (?, ?, 'T', 't', ?)").run(lib * 10, lib, now);
    db.prepare("INSERT INTO lib_tags (id, library_id, name, name_norm, created_at) VALUES (?, ?, 'x', 'x', ?), (?, ?, 'y', 'y', ?)").run(lib * 10, lib, now, lib * 10 + 1, lib, now);
  }
  const addDoc = (lib: number, tags: number[], deleted: number | null = null) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO lib_documents (library_id, title, added, modified, correspondent_id, document_type_id, mime_type, source, deleted_at)
           VALUES (?, 'd', '2024-01-01', '2024-01-01', ?, ?, 'application/pdf', 'test', ?)`,
        )
        .run(lib, lib * 10, lib * 10, deleted).lastInsertRowid,
    );
    for (const t of tags) db.prepare('INSERT INTO lib_document_tags (tag_id, document_id, library_id) VALUES (?, ?, ?)').run(t, id, lib);
    return id;
  };
  const count = (lib: number, kind: string, item = 0) =>
    (db.prepare('SELECT count FROM lib_counters WHERE library_id = ? AND kind = ? AND item_id = ?').get(lib, kind, item) as { count: number } | undefined)?.count ?? 0;
  return { db, addDoc, count };
}

describe('archive counters', () => {
  it('follow inserts, trash, restore, moves, metadata deletes and purges', () => {
    const { db, addDoc, count } = setup();
    const a = addDoc(1, [10, 11]);
    const b = addDoc(1, [10]);
    addDoc(1, [10], Date.now()); // in the trash: not counted
    expect(count(1, 'documents')).toBe(2);
    expect(count(1, 'tag', 10)).toBe(2);
    expect(count(1, 'correspondent', 10)).toBe(2);
    expect(checkCounters(db)).toBe(0);

    db.prepare('UPDATE lib_documents SET deleted_at = ? WHERE id = ?').run(Date.now(), a);
    expect(count(1, 'documents')).toBe(1);
    expect(count(1, 'tag', 11)).toBe(0);
    db.prepare('UPDATE lib_documents SET deleted_at = NULL WHERE id = ?').run(a);
    expect(count(1, 'tag', 11)).toBe(1);
    expect(checkCounters(db)).toBe(0);

    // Move b to library 2, tags remapped like the backend does.
    db.transaction(() => {
      db.prepare('UPDATE lib_documents SET library_id = 2, correspondent_id = 20, document_type_id = NULL WHERE id = ?').run(b);
      db.prepare('DELETE FROM lib_document_tags WHERE document_id = ?').run(b);
      db.prepare('INSERT INTO lib_document_tags (tag_id, document_id, library_id) VALUES (20, ?, 2)').run(b);
    })();
    expect(count(1, 'documents')).toBe(1);
    expect(count(2, 'documents')).toBe(1);
    expect(count(2, 'tag', 20)).toBe(1);
    expect(count(2, 'document_type', 20)).toBe(0);
    expect(checkCounters(db)).toBe(0);

    // Deleting metadata: ON DELETE SET NULL / CASCADE update the counters too.
    db.prepare('DELETE FROM lib_correspondents WHERE id = 10').run();
    db.prepare('DELETE FROM lib_tags WHERE id = 10').run();
    expect(count(1, 'correspondent', 10)).toBe(0);
    expect(count(1, 'tag', 10)).toBe(0);
    expect(checkCounters(db)).toBe(0);

    // Purging an active and a trashed document.
    db.prepare('DELETE FROM lib_documents WHERE id = ?').run(a);
    db.prepare('DELETE FROM lib_documents WHERE deleted_at IS NOT NULL').run();
    expect(count(1, 'documents')).toBe(0);
    expect(count(1, 'tag', 11)).toBe(0);
    expect(checkCounters(db)).toBe(0);
  });

  it('rebuild repairs drifted counters', () => {
    const { db, addDoc } = setup();
    addDoc(1, [10]);
    db.prepare("UPDATE lib_counters SET count = 99 WHERE kind = 'documents'").run();
    expect(checkCounters(db)).toBe(1);
    rebuildCounters(db);
    expect(checkCounters(db)).toBe(0);
  });
});

describe('migration 13', () => {
  it('recreates a lib_fts without the 4-letter prefix index and flags a rebuild', () => {
    const { db, addDoc } = setup();
    addDoc(1, [10]);
    db.exec(`DROP TABLE lib_fts;
      CREATE VIRTUAL TABLE lib_fts USING fts5(title, body, meta, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
      DELETE FROM schema_migrations WHERE version = 13; DELETE FROM lib_counters;`);
    migrate(db);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lib_fts'").get() as { sql: string }).sql).toContain("prefix = '3 4'");
    expect((db.prepare("SELECT value FROM kv WHERE key = 'archive.fts_rebuild'").get() as { value: string }).value).toBe('true');
    expect(checkCounters(db)).toBe(0);
    expect((db.prepare("SELECT count FROM lib_counters WHERE kind = 'documents'").get() as { count: number }).count).toBe(1);
  });

  it('leaves a current lib_fts alone', () => {
    const { db } = setup();
    db.exec('DELETE FROM schema_migrations WHERE version = 13');
    migrate(db);
    expect(db.prepare("SELECT 1 FROM kv WHERE key = 'archive.fts_rebuild'").get()).toBeUndefined();
  });
});
