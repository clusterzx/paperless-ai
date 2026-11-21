import type { EventKind, SuggestedEvent } from '../../shared/api.js';
import type { Db } from './database.js';

export interface CalendarEventRow {
  id: number;
  document_id: number;
  document_title: string | null;
  title: string;
  date: string;
  time: string | null;
  kind: EventKind;
  dismissed_at: number | null;
  created_at: number;
}

export interface CalendarQuery {
  /** YYYY-MM-DD, inclusive */
  from?: string;
  to?: string;
  dismissed?: boolean;
  limit?: number;
  ids?: number[];
  /**
   * Built-in archive: only dates of documents in these libraries. `null`/undefined = no restriction
   * (companion mode, system).
   */
  libraryIds?: number[] | null;
}

const sameEvent = (a: { date: string; title: string }, b: { date: string; title: string }) => a.date === b.date && a.title.toLowerCase() === b.title.toLowerCase();

/** Dates found in documents, and which documents were searched for them. */
export class CalendarRepo {
  constructor(private readonly db: Db) {}

  /**
   * The dates of a document after it was analysed (again): replaces the earlier ones. A date the user
   * dismissed stays dismissed instead of coming back.
   */
  replaceForDocument(documentId: number, documentTitle: string | null, events: SuggestedEvent[]): number {
    return this.db.transaction(() => {
      const dismissed = this.db
        .prepare('SELECT date, title FROM calendar_events WHERE document_id = ? AND dismissed_at IS NOT NULL')
        .all(documentId) as { date: string; title: string }[];
      this.db.prepare('DELETE FROM calendar_events WHERE document_id = ? AND dismissed_at IS NULL').run(documentId);
      this.db.prepare('UPDATE calendar_events SET document_title = ? WHERE document_id = ?').run(documentTitle, documentId);
      const insert = this.db.prepare(
        'INSERT INTO calendar_events (document_id, document_title, title, date, time, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const now = Date.now();
      let added = 0;
      for (const e of events) {
        if (dismissed.some((d) => sameEvent(d, e))) continue;
        insert.run(documentId, documentTitle, e.title, e.date, e.time, e.kind, now);
        added++;
      }
      this.db
        .prepare(
          'INSERT INTO calendar_scans (document_id, scanned_at, events, error) VALUES (?, ?, ?, NULL) ON CONFLICT(document_id) DO UPDATE SET scanned_at = excluded.scanned_at, events = excluded.events, error = NULL',
        )
        .run(documentId, now, events.length);
      return added;
    })();
  }

  /** Forget the dates of a deleted document (and that it was scanned). */
  removeDocument(documentId: number): void {
    this.db.prepare('DELETE FROM calendar_events WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM calendar_scans WHERE document_id = ?').run(documentId);
  }

  markScanFailed(documentId: number, error: string): void {
    this.db
      .prepare(
        'INSERT INTO calendar_scans (document_id, scanned_at, events, error) VALUES (?, ?, 0, ?) ON CONFLICT(document_id) DO UPDATE SET scanned_at = excluded.scanned_at, error = excluded.error',
      )
      .run(documentId, Date.now(), error.slice(0, 500));
  }

  /** Documents already searched successfully. */
  scannedIds(): Set<number> {
    return new Set((this.db.prepare('SELECT document_id FROM calendar_scans WHERE error IS NULL').all() as { document_id: number }[]).map((r) => r.document_id));
  }

  scannedCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM calendar_scans WHERE error IS NULL').get() as { c: number }).c;
  }

  list(q: CalendarQuery = {}): CalendarEventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.from) {
      where.push('date >= ?');
      args.push(q.from);
    }
    if (q.to) {
      where.push('date <= ?');
      args.push(q.to);
    }
    if (!q.dismissed) where.push('dismissed_at IS NULL');
    if (q.ids) {
      where.push('id IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(q.ids));
    }
    if (q.libraryIds) {
      where.push('document_id IN (SELECT id FROM lib_documents WHERE deleted_at IS NULL AND library_id IN (SELECT value FROM json_each(?)))');
      args.push(JSON.stringify(q.libraryIds));
    }
    const sql = `SELECT * FROM calendar_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY date, time IS NOT NULL, time, id LIMIT ?`;
    return this.db.prepare(sql).all(...args, q.limit ?? 5000) as CalendarEventRow[];
  }

  get(id: number): CalendarEventRow | undefined {
    return this.db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id) as CalendarEventRow | undefined;
  }

  setDismissed(id: number, dismissed: boolean): boolean {
    return this.db.prepare('UPDATE calendar_events SET dismissed_at = ? WHERE id = ?').run(dismissed ? Date.now() : null, id).changes > 0;
  }
}
