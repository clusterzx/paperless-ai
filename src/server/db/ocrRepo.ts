import type { Db } from './database.js';
import type { OcrFilter, OcrResultInfo, TextQuality, TextQualityLevel } from '../../shared/api.js';

export interface OcrAssessment {
  id: number;
  title: string;
  modified: string | null;
  created: string | null;
  pages: number | null;
  quality: TextQuality;
}

export interface OcrResultRow {
  document_id: number;
  status: 'done' | 'failed';
  text: string | null;
  previous_text: string | null;
  chars: number | null;
  pages: number | null;
  total_pages: number | null;
  mean_score: number | null;
  provider: string | null;
  duration_ms: number | null;
  source_modified: string | null;
  written_modified: string | null;
  written_back: number;
  error: string | null;
  attempts: number;
  created_at: number;
  reverted_at: number | null;
  score_before: number | null;
  score_after: number | null;
  kept_original: number;
}

interface AssessmentRow {
  id: number;
  title: string;
  modified: string | null;
  created: string | null;
  pages: number | null;
  chars: number;
  score: number;
  level: TextQualityLevel;
  reasons: string;
}

export interface NewOcrResult {
  text: string;
  chars: number;
  pages: number;
  totalPages: number;
  meanScore: number;
  provider: string;
  durationMs: number;
  sourceModified: string | null;
  /** Text-quality scores of the Paperless text before the OCR and of the OCR text. */
  scoreBefore: number;
  scoreAfter: number;
  /** The OCR text did not score better – Paperless keeps its text. */
  keptOriginal: boolean;
}

export interface OcrListQuery {
  filter?: OcrFilter;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: 'score' | 'id' | 'title' | 'ocr';
  order?: 'asc' | 'desc';
}

const FILTERS: Record<OcrFilter, string> = {
  all: '1 = 1',
  needs: `d.level IN ('missing', 'poor') AND (r.status IS NULL OR r.status = 'failed' OR r.reverted_at IS NOT NULL)`,
  missing: `d.level = 'missing'`,
  poor: `d.level = 'poor'`,
  fair: `d.level = 'fair'`,
  good: `d.level = 'good'`,
  done: `r.status = 'done' AND r.reverted_at IS NULL`,
  failed: `r.status = 'failed'`,
};

export function resultInfo(r: OcrResultRow | undefined | null): OcrResultInfo | null {
  if (!r) return null;
  return {
    status: r.status,
    at: r.created_at,
    chars: r.chars,
    meanScore: r.mean_score,
    pages: r.pages,
    totalPages: r.total_pages,
    provider: r.provider,
    durationMs: r.duration_ms,
    writtenBack: Boolean(r.written_back),
    revertedAt: r.reverted_at,
    error: r.error,
    scoreBefore: r.score_before,
    scoreAfter: r.score_after,
    keptOriginal: Boolean(r.kept_original),
  };
}

function toAssessment(row: AssessmentRow): OcrAssessment {
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(row.reasons) as string[];
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    title: row.title,
    modified: row.modified,
    created: row.created,
    pages: row.pages,
    quality: { score: row.score, level: row.level, reasons, chars: row.chars, words: 0 },
  };
}

export class OcrRepo {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------ assessments

  /** Paperless "modified" of every assessed document. */
  assessedVersions(): Map<number, string | null> {
    const rows = this.db.prepare('SELECT id, modified FROM ocr_documents').all() as { id: number; modified: string | null }[];
    return new Map(rows.map((r) => [r.id, r.modified]));
  }

  saveAssessments(items: OcrAssessment[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO ocr_documents (id, title, modified, created, pages, chars, score, level, reasons, assessed_at)
       VALUES (@id, @title, @modified, @created, @pages, @chars, @score, @level, @reasons, @now)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, modified = excluded.modified, created = excluded.created,
         pages = excluded.pages, chars = excluded.chars, score = excluded.score, level = excluded.level,
         reasons = excluded.reasons, assessed_at = excluded.assessed_at`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const a of items) {
        stmt.run({
          id: a.id,
          title: a.title,
          modified: a.modified,
          created: a.created,
          pages: a.pages,
          chars: a.quality.chars,
          score: a.quality.score,
          level: a.quality.level,
          reasons: JSON.stringify(a.quality.reasons),
          now,
        });
      }
    })();
  }

  assessment(id: number): OcrAssessment | undefined {
    const row = this.db.prepare('SELECT * FROM ocr_documents WHERE id = ?').get(id) as AssessmentRow | undefined;
    return row ? toAssessment(row) : undefined;
  }

  /** Forget documents that no longer exist in Paperless. */
  removeMissing(existing: Set<number>): number {
    const ids = (this.db.prepare('SELECT id FROM ocr_documents').all() as { id: number }[]).map((r) => r.id).filter((id) => !existing.has(id));
    const del = this.db.prepare('DELETE FROM ocr_documents WHERE id = ?');
    const delResult = this.db.prepare('DELETE FROM ocr_results WHERE document_id = ?');
    this.db.transaction(() => {
      for (const id of ids) {
        del.run(id);
        delResult.run(id);
      }
    })();
    return ids.length;
  }

  counts(): Record<OcrFilter, number> {
    const out = {} as Record<OcrFilter, number>;
    for (const [key, where] of Object.entries(FILTERS) as [OcrFilter, string][]) {
      out[key] = (
        this.db.prepare(`SELECT COUNT(*) AS c FROM ocr_documents d LEFT JOIN ocr_results r ON r.document_id = d.id WHERE ${where}`).get() as {
          c: number;
        }
      ).c;
    }
    return out;
  }

  list(q: OcrListQuery): { items: (OcrAssessment & { result: OcrResultRow | null })[]; total: number; page: number; pageSize: number } {
    const pageSize = Math.min(Math.max(q.pageSize ?? 50, 1), 500);
    const page = Math.max(q.page ?? 1, 1);
    const where = [FILTERS[q.filter ?? 'all']];
    const params: Record<string, unknown> = {};
    if (q.search?.trim()) {
      const s = q.search.trim();
      params.search = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      if (/^\d+$/.test(s)) {
        params.id = Number(s);
        where.push(`(d.id = @id OR d.title LIKE @search ESCAPE '\\')`);
      } else where.push(`d.title LIKE @search ESCAPE '\\'`);
    }
    const sortCol = { score: 'd.score', id: 'd.id', title: 'd.title COLLATE NOCASE', ocr: 'COALESCE(r.created_at, 0)' }[q.sort ?? 'score'];
    const order = (q.order ?? (q.sort === 'score' || !q.sort ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
    const sql = `FROM ocr_documents d LEFT JOIN ocr_results r ON r.document_id = d.id WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS c ${sql}`).get(params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT d.*, r.document_id AS r_document_id ${sql} ORDER BY ${sortCol} ${order}, d.id DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as (AssessmentRow & { r_document_id: number | null })[];
    const results = this.resultsFor(rows.filter((r) => r.r_document_id !== null).map((r) => r.id));
    return {
      items: rows.map((row) => ({ ...toAssessment(row), result: results.get(row.id) ?? null })),
      total,
      page,
      pageSize,
    };
  }

  /** IDs of documents matching a filter (for "OCR all poor documents"). */
  ids(filter: OcrFilter, limit = 100_000): number[] {
    return (
      this.db
        .prepare(`SELECT d.id FROM ocr_documents d LEFT JOIN ocr_results r ON r.document_id = d.id WHERE ${FILTERS[filter]} ORDER BY d.score ASC, d.id LIMIT ?`)
        .all(limit) as { id: number }[]
    ).map((r) => r.id);
  }

  // ------------------------------------------------------------ results

  result(id: number): OcrResultRow | undefined {
    return this.db.prepare('SELECT * FROM ocr_results WHERE document_id = ?').get(id) as OcrResultRow | undefined;
  }

  private resultsFor(ids: number[]): Map<number, OcrResultRow> {
    if (!ids.length) return new Map();
    const rows = this.db
      .prepare(`SELECT * FROM ocr_results WHERE document_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as OcrResultRow[];
    return new Map(rows.map((r) => [r.document_id, r]));
  }

  /** OCR text that replaces the Paperless text of this document version (kept only locally, not written back). */
  localText(id: number, modified: string | null): string | null {
    const r = this.result(id);
    if (!r || r.status !== 'done' || r.reverted_at || r.written_back || r.kept_original || !r.text) return null;
    return r.source_modified === modified ? r.text : null;
  }

  saveResult(id: number, r: NewOcrResult): void {
    this.db
      .prepare(
        `INSERT INTO ocr_results (document_id, status, text, previous_text, chars, pages, total_pages, mean_score, provider, duration_ms,
           source_modified, written_modified, written_back, error, attempts, created_at, reverted_at, score_before, score_after, kept_original)
         VALUES (@id, 'done', @text, NULL, @chars, @pages, @totalPages, @meanScore, @provider, @durationMs, @sourceModified, NULL, 0, NULL,
           1, @now, NULL, @scoreBefore, @scoreAfter, @keptOriginal)
         ON CONFLICT(document_id) DO UPDATE SET status = 'done', text = excluded.text, previous_text = NULL, chars = excluded.chars,
           pages = excluded.pages, total_pages = excluded.total_pages, mean_score = excluded.mean_score, provider = excluded.provider,
           duration_ms = excluded.duration_ms, source_modified = excluded.source_modified, written_modified = NULL, written_back = 0,
           error = NULL, attempts = ocr_results.attempts + 1, created_at = excluded.created_at, reverted_at = NULL,
           score_before = excluded.score_before, score_after = excluded.score_after, kept_original = excluded.kept_original`,
      )
      .run({ id, ...r, keptOriginal: r.keptOriginal ? 1 : 0, now: Date.now() });
  }

  saveFailure(id: number, error: string, sourceModified: string | null): void {
    this.db
      .prepare(
        `INSERT INTO ocr_results (document_id, status, error, source_modified, attempts, created_at)
         VALUES (@id, 'failed', @error, @sourceModified, 1, @now)
         ON CONFLICT(document_id) DO UPDATE SET status = 'failed', error = excluded.error, source_modified = excluded.source_modified,
           attempts = ocr_results.attempts + 1, created_at = excluded.created_at`,
      )
      .run({ id, error: error.slice(0, 2000), sourceModified, now: Date.now() });
  }

  /** The user saved an OCR text in Paperless that was kept back (or reverted) before. */
  markApplied(id: number, previousText: string, writtenModified: string | null): void {
    this.db
      .prepare(
        'UPDATE ocr_results SET written_back = 1, kept_original = 0, reverted_at = NULL, previous_text = ?, written_modified = ? WHERE document_id = ?',
      )
      .run(previousText, writtenModified, id);
  }

  markWrittenBack(id: number, previousText: string, writtenModified: string | null): void {
    this.db
      .prepare('UPDATE ocr_results SET written_back = 1, previous_text = ?, written_modified = ? WHERE document_id = ?')
      .run(previousText, writtenModified, id);
  }

  /**
   * Paperless-AI changed the document itself (title, tags, …): the stored OCR text still belongs to
   * it, only its `modified` moved on.
   */
  followVersion(id: number, from: string | null, to: string | null): void {
    if (from === to) return;
    this.db.prepare('UPDATE ocr_results SET source_modified = ? WHERE document_id = ? AND written_back = 0 AND source_modified IS ?').run(to, id, from);
    this.db.prepare('UPDATE ocr_results SET written_modified = ? WHERE document_id = ? AND written_back = 1 AND written_modified IS ?').run(to, id, from);
  }

  markReverted(id: number, modified: string | null): void {
    this.db.prepare('UPDATE ocr_results SET reverted_at = ?, written_modified = ? WHERE document_id = ?').run(Date.now(), modified, id);
  }
}
