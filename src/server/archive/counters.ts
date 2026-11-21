/**
 * Document counts per library, tag, correspondent and document type (docs/standalone/search-and-scale.md §4).
 * SQLite triggers keep them up to date in the same transaction as the change, so unfiltered facets
 * and the counts in the metadata lists never scan the archive. Only documents outside the trash count.
 */
import type { Db } from '../db/database.js';

const UPSERT = 'ON CONFLICT (library_id, kind, item_id) DO UPDATE SET count = count + excluded.count;';

/** Effect of a document row (doc = OLD or NEW) on the counters, its tags excluded. */
function docRow(doc: 'OLD' | 'NEW', delta: 1 | -1, when = 'true'): string {
  return `
  INSERT INTO lib_counters (library_id, kind, item_id, count) SELECT ${doc}.library_id, 'documents', 0, ${delta} WHERE ${when} ${UPSERT}
  INSERT INTO lib_counters (library_id, kind, item_id, count) SELECT ${doc}.library_id, 'correspondent', ${doc}.correspondent_id, ${delta}
    WHERE ${when} AND ${doc}.correspondent_id IS NOT NULL ${UPSERT}
  INSERT INTO lib_counters (library_id, kind, item_id, count) SELECT ${doc}.library_id, 'document_type', ${doc}.document_type_id, ${delta}
    WHERE ${when} AND ${doc}.document_type_id IS NOT NULL ${UPSERT}`;
}

/** The tags of a document, counted in the library stored on the tag rows. */
function docTags(doc: 'OLD' | 'NEW', delta: 1 | -1, when = 'true'): string {
  return `
  INSERT INTO lib_counters (library_id, kind, item_id, count) SELECT library_id, 'tag', tag_id, ${delta}
    FROM lib_document_tags WHERE document_id = ${doc}.id AND ${when} ${UPSERT}`;
}

const ACTIVE_DOC = (doc: string) => `EXISTS (SELECT 1 FROM lib_documents WHERE id = ${doc}.document_id AND deleted_at IS NULL)`;

/**
 * Sorting by date uses COALESCE(created, '') (documents without a date last, stable keyset cursor);
 * these indexes have the same expression, so newest-first lists read 50 index entries instead of
 * sorting the whole library.
 */
export const SORT_INDEXES = `
CREATE INDEX IF NOT EXISTS lib_docs_created_sort ON lib_documents(COALESCE(created, '') DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS lib_docs_lib_created_sort ON lib_documents(library_id, COALESCE(created, '') DESC, id DESC) WHERE deleted_at IS NULL;
`;

export const COUNTER_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS lib_counters_doc_insert AFTER INSERT ON lib_documents WHEN NEW.deleted_at IS NULL BEGIN
  ${docRow('NEW', 1)}
END;

-- BEFORE: the tag rows still exist; their cascade delete afterwards no longer sees an active document.
CREATE TRIGGER IF NOT EXISTS lib_counters_doc_delete BEFORE DELETE ON lib_documents WHEN OLD.deleted_at IS NULL BEGIN
  ${docRow('OLD', -1)}
  ${docTags('OLD', -1)}
END;

CREATE TRIGGER IF NOT EXISTS lib_counters_doc_update AFTER UPDATE OF library_id, correspondent_id, document_type_id, deleted_at ON lib_documents
WHEN OLD.library_id IS NOT NEW.library_id OR OLD.correspondent_id IS NOT NEW.correspondent_id
  OR OLD.document_type_id IS NOT NEW.document_type_id OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL) BEGIN
  ${docRow('OLD', -1, 'OLD.deleted_at IS NULL')}
  ${docRow('NEW', 1, 'NEW.deleted_at IS NULL')}
  ${docTags('OLD', -1, 'OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL')}
  ${docTags('NEW', 1, 'OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL')}
END;

CREATE TRIGGER IF NOT EXISTS lib_counters_tag_insert AFTER INSERT ON lib_document_tags WHEN ${ACTIVE_DOC('NEW')} BEGIN
  INSERT INTO lib_counters (library_id, kind, item_id, count) VALUES (NEW.library_id, 'tag', NEW.tag_id, 1) ${UPSERT}
END;

CREATE TRIGGER IF NOT EXISTS lib_counters_tag_delete AFTER DELETE ON lib_document_tags WHEN ${ACTIVE_DOC('OLD')} BEGIN
  INSERT INTO lib_counters (library_id, kind, item_id, count) VALUES (OLD.library_id, 'tag', OLD.tag_id, -1) ${UPSERT}
END;

CREATE TRIGGER IF NOT EXISTS lib_counters_tag_gone AFTER DELETE ON lib_tags BEGIN
  DELETE FROM lib_counters WHERE library_id = OLD.library_id AND kind = 'tag' AND item_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS lib_counters_correspondent_gone AFTER DELETE ON lib_correspondents BEGIN
  DELETE FROM lib_counters WHERE library_id = OLD.library_id AND kind = 'correspondent' AND item_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS lib_counters_type_gone AFTER DELETE ON lib_document_types BEGIN
  DELETE FROM lib_counters WHERE library_id = OLD.library_id AND kind = 'document_type' AND item_id = OLD.id;
END;
`;

const REBUILD = `
  DELETE FROM lib_counters;
  INSERT INTO lib_counters (library_id, kind, item_id, count)
    SELECT library_id, 'documents', 0, COUNT(*) FROM lib_documents WHERE deleted_at IS NULL GROUP BY library_id;
  INSERT INTO lib_counters (library_id, kind, item_id, count)
    SELECT library_id, 'correspondent', correspondent_id, COUNT(*) FROM lib_documents
    WHERE deleted_at IS NULL AND correspondent_id IS NOT NULL GROUP BY library_id, correspondent_id;
  INSERT INTO lib_counters (library_id, kind, item_id, count)
    SELECT library_id, 'document_type', document_type_id, COUNT(*) FROM lib_documents
    WHERE deleted_at IS NULL AND document_type_id IS NOT NULL GROUP BY library_id, document_type_id;
  INSERT INTO lib_counters (library_id, kind, item_id, count)
    SELECT t.library_id, 'tag', t.tag_id, COUNT(*) FROM lib_document_tags t
    JOIN lib_documents d ON d.id = t.document_id AND d.deleted_at IS NULL GROUP BY t.library_id, t.tag_id;
`;

/** Counters from scratch – in the migration, and when the weekly check finds a difference. */
export function rebuildCounters(db: Db): void {
  db.transaction(() => db.exec(REBUILD))();
}

/** Do the counters match a recount? Returns the number of differing entries (0 = consistent). */
export function checkCounters(db: Db): number {
  const stored = new Map<string, number>();
  for (const r of db.prepare('SELECT library_id, kind, item_id, count FROM lib_counters WHERE count <> 0').all() as { library_id: number; kind: string; item_id: number; count: number }[]) {
    stored.set(`${r.library_id}/${r.kind}/${r.item_id}`, r.count);
  }
  let diff = 0;
  const recount = REBUILD.split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('INSERT'))
    .map((s) => s.replace(/^INSERT INTO lib_counters \(library_id, kind, item_id, count\)\s*/, ''));
  for (const sql of recount) {
    for (const r of db.prepare(sql).raw().all() as [number, string, number, number][]) {
      const key = `${r[0]}/${r[1]}/${r[2]}`;
      if (stored.get(key) !== r[3]) diff++;
      stored.delete(key);
    }
  }
  return diff + stored.size;
}
