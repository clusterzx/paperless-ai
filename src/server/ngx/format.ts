/**
 * Shapes of the Paperless-ngx REST API (docs.paperless-ngx.com/api) for the compatible API under
 * /ngx/api/: objects, pagination, filters and orderings translated to and from Paperless-AI's own
 * model. The internal document model already follows the Paperless-ngx document object.
 */
import type { FastifyRequest } from 'fastify';
import type { ArchiveDocument, DocumentFilter, DocumentSort } from '../backend/types.js';
import { localDay } from '../../shared/dates.js';

/** API versions of Paperless-ngx this layer answers (Accept: application/json; version=N). */
export const MIN_API_VERSION = 1;
export const MAX_API_VERSION = 9;
/** Paperless-ngx release whose API this layer follows (apps show it and enable features by it). */
export const NGX_VERSION = '2.17.1';

/** The API version a request asks for (`Accept: application/json; version=N`), else the newest. */
export function requestedVersion(req: FastifyRequest): number | null {
  // `version=9` (Paperless Mobile, Swift Paperless) or `Version=9` (Paperparrot).
  const m = /version\s*=\s*(\d+)/i.exec(String(req.headers.accept ?? ''));
  return m ? Number(m[1]) : null;
}

export function apiVersion(req: FastifyRequest): number {
  return requestedVersion(req) ?? MAX_API_VERSION;
}

/** The public base of the compatible API as the client reached it (for `next` / `previous` links). */
export function baseUrl(req: FastifyRequest): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  all?: number[];
  results: T[];
}

/** page / page_size of a list request (Paperless-ngx: 1-based pages, 25 per page by default). */
export function pageParams(q: Record<string, string | undefined>, defaultSize = 25, maxSize = 100_000): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const pageSize = Math.min(maxSize, Math.max(1, Math.floor(Number(q.page_size) || defaultSize)));
  return { page, pageSize };
}

/** A paginated answer with links to the neighbouring pages (the query kept, the page replaced). */
export function paginate<T>(req: FastifyRequest, items: T[], count: number, page: number, pageSize: number, all?: number[]): Page<T> {
  const link = (p: number) => {
    const u = new URL(req.url, baseUrl(req));
    u.searchParams.set('page', String(p));
    return `${baseUrl(req)}${u.pathname}${u.search}`;
  };
  const out: Page<T> = {
    count,
    next: page * pageSize < count ? link(page + 1) : null,
    previous: page > 1 ? link(page - 1) : null,
    results: items,
  };
  // Version 10 dropped the list of all ids; earlier versions always send it.
  if (all && apiVersion(req) < 10) out.all = all;
  return out;
}

/** Paginate a list that is fully in memory. */
export function paginateList<T extends { id: number }>(req: FastifyRequest, items: T[], q: Record<string, string | undefined>): Page<T> {
  const { page, pageSize } = pageParams(q);
  return paginate(
    req,
    items.slice((page - 1) * pageSize, page * pageSize),
    items.length,
    page,
    pageSize,
    items.map((i) => i.id),
  );
}

const list = (v: string | undefined): number[] =>
  (v ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

const dateOf = (v: string | undefined): string | undefined => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The document filters of Paperless-ngx (query parameters of /api/documents/) as a DocumentFilter.
 * Unknown parameters are ignored, as Paperless-ngx (django-filter) does.
 */
export function filterFromQuery(q: Record<string, string | undefined>, today = new Date()): DocumentFilter {
  const f: DocumentFilter = {};
  // Relative date ranges in the full text query, as Paperless Mobile sends them: created:[-1 week to now].
  const ranges = takeDateRanges(q.query ?? q.title_content ?? q.text ?? q.search ?? '', today);
  const text = ranges.rest;
  if (text.trim()) f.query = text.trim();
  if (ranges.created.from) f.createdFrom = ranges.created.from;
  if (ranges.created.to) f.createdTo = ranges.created.to;
  if (ranges.added.from) f.addedFrom = ranges.added.from;
  if (ranges.added.to) f.addedTo = ranges.added.to;
  const title = q.title__icontains ?? q.title_search;
  if (title?.trim()) f.titleQuery = title.trim();
  if (q.content__icontains?.trim()) f.contentQuery = q.content__icontains.trim();
  if (q.id__in) f.ids = list(q.id__in);
  if (q.id) f.ids = list(q.id);

  if (q.tags__id__all) f.tagsAll = list(q.tags__id__all);
  if (q.tags__id__in) f.tagsAny = list(q.tags__id__in);
  if (q.tags__id__none) f.tagsNone = list(q.tags__id__none);
  if (q.tags__id) f.tagsAll = [...(f.tagsAll ?? []), ...list(q.tags__id)];

  if (q.correspondent__isnull === 'true' || q.correspondent__isnull === '1') f.correspondent = null;
  else if (q.correspondent__id) f.correspondents = list(q.correspondent__id);
  else if (q.correspondent__id__in) f.correspondents = list(q.correspondent__id__in);
  if (q.correspondent__id__none) f.correspondentsNone = list(q.correspondent__id__none);

  if (q.document_type__isnull === 'true' || q.document_type__isnull === '1') f.documentType = null;
  else if (q.document_type__id) f.documentTypes = list(q.document_type__id);
  else if (q.document_type__id__in) f.documentTypes = list(q.document_type__id__in);
  if (q.document_type__id__none) f.documentTypesNone = list(q.document_type__id__none);

  if (q.storage_path__isnull === 'false' || q.storage_path__id || q.storage_path__id__in) f.ids = [-1]; // no storage paths here
  if (q.owner__id) f.owner = Number(q.owner__id) || null;
  if (q.owner__isnull === 'true') f.owner = null;

  // Dates: created/added with __date__ or without, gt/gte/lt/lte; "gt" is the day after.
  const created = { gte: dateOf(q.created__date__gte ?? q.created__gte), gt: dateOf(q.created__date__gt ?? q.created__gt), lte: dateOf(q.created__date__lte ?? q.created__lte), lt: dateOf(q.created__date__lt ?? q.created__lt) };
  if (created.gte) f.createdFrom = created.gte;
  if (created.gt) f.createdFrom = dayAfter(created.gt);
  if (created.lte) f.createdTo = created.lte;
  if (created.lt) f.createdTo = dayBefore(created.lt);
  if (q.created__year) f.createdYear = Number(q.created__year) || undefined;
  if (q.created__month) f.createdMonth = Number(q.created__month) || undefined;
  const added = { gte: dateOf(q.added__date__gte ?? q.added__gte), gt: dateOf(q.added__date__gt ?? q.added__gt), lte: dateOf(q.added__date__lte ?? q.added__lte), lt: dateOf(q.added__date__lt ?? q.added__lt) };
  if (added.gte) f.addedFrom = added.gte;
  if (added.gt) f.addedFrom = dayAfter(added.gt);
  if (added.lte) f.addedTo = added.lte;
  if (added.lt) f.addedTo = dayBefore(added.lt);

  const asn = q.archive_serial_number ?? q.asn;
  if (asn && Number.isInteger(Number(asn))) f.asn = Number(asn);
  // No inbox tags here: "in the inbox" matches nothing.
  if (q.is_in_inbox === 'true' || q.is_in_inbox === '1') f.ids = [-1];
  if (q.is_tagged === 'false' || q.is_tagged === '0') f.tagged = false;
  if (q.is_tagged === 'true' || q.is_tagged === '1') f.tagged = true;
  return f;
}

/** A point in time of Whoosh's relative syntax ("now", "-1 week", "-3 month", "-1 year", a date) as a day. */
function relativeDay(expr: string, today: Date): string | null {
  const e = expr.trim().toLowerCase();
  if (e === 'now' || e === 'today') return localDay(today);
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return e;
  if (/^\d{8}$/.test(e)) return `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
  const m = /^-?\s*(\d+)\s*(day|week|month|year)s?$/.exec(e);
  if (!m) return null;
  const n = Number(m[1]);
  // From the local day (TZ), then counted back as a date-only value.
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  if (m[2] === 'day') d.setUTCDate(d.getUTCDate() - n);
  if (m[2] === 'week') d.setUTCDate(d.getUTCDate() - 7 * n);
  if (m[2] === 'month') d.setUTCMonth(d.getUTCMonth() - n);
  if (m[2] === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/** Takes `created:[a to b]` / `added:[a to b]` out of a full text query (and splits several queries joined with commas). */
export function takeDateRanges(query: string, today = new Date()): { rest: string; created: { from?: string; to?: string }; added: { from?: string; to?: string } } {
  const out = { rest: query, created: {} as { from?: string; to?: string }, added: {} as { from?: string; to?: string } };
  // A plain scan instead of a pattern: patterns for `field:[ … ]` take quadratic time on queries
  // built to hit them – long runs of spaces, or many `added:[` without a closing bracket
  // (CodeQL js/polynomial-redos). Every character is looked at a bounded number of times.
  const lower = query.toLowerCase();
  let rest = '';
  let i = 0;
  let close = -1;
  while (i < query.length) {
    const open = lower.indexOf(':[', i);
    if (open < 0) break;
    // The first `]` after the bracket – the same for every bracket before it, so searched once.
    if (close < open + 2) close = query.indexOf(']', open + 2);
    if (close < 0) break;
    let start = open;
    while (start > i && lower.charCodeAt(start - 1) >= 97 && lower.charCodeAt(start - 1) <= 122) start--;
    const field = lower.slice(start, open);
    if (field === 'created' || field === 'added' || field === 'modified') {
      const text = query.slice(open + 2, close).replace(/\s+/g, ' ');
      const at = text.toLowerCase().indexOf(' to ');
      if (at >= 0) {
        if (field !== 'modified') {
          const from = relativeDay(text.slice(0, at), today);
          const to = relativeDay(text.slice(at + 4), today);
          if (from) out[field].from = from;
          if (to) out[field].to = to;
        }
        rest += `${query.slice(i, start)} `;
        i = close + 1;
        continue;
      }
    }
    rest += query.slice(i, open + 2);
    i = open + 2;
  }
  rest += query.slice(i);
  out.rest = rest.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** True when the filter cannot match anything (e.g. storage paths, which do not exist here). */
export const matchesNothing = (f: DocumentFilter) => f.ids?.length === 1 && f.ids[0] === -1;

/** The ordering of Paperless-ngx (`ordering=-created`) as a sort of Paperless-AI. */
export function sortFromOrdering(ordering: string | undefined, hasQuery: boolean): DocumentSort {
  // Apps send a tie-breaker after the field ("-created,id"): the first field decides.
  const o = (ordering ?? '').split(',')[0].trim();
  const map: Record<string, DocumentSort> = {
    created: 'created',
    '-created': '-created',
    added: 'added',
    '-added': '-added',
    modified: 'modified',
    '-modified': '-modified',
    title: 'title',
    '-title': '-title',
    id: 'added',
    '-id': '-added',
  };
  if (map[o]) return map[o];
  if ((o === '-score' || o === 'score' || !o) && hasQuery) return 'relevance';
  return '-created';
}

/** A document as Paperless-ngx sends it (for the API version of the request). */
/** Seconds from 1970 to 2001-01-01, the reference date of Apple's platforms. */
const APPLE_EPOCH_SECONDS = 978_307_200;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A document date as the apps send it, as a day (YYYY-MM-DD), or null when it is none:
 * - "2024-03-31", or a date and time without a time zone: the day as written;
 * - a date and time with a time zone: the day in the server's time zone (as Paperless-ngx does);
 * - a number: seconds since 2001 – how Swift's JSONEncoder writes a date unless told otherwise
 *   (Paperparrot). A day picked in the app is midnight on the phone, so the nearest midnight counts.
 */
export function documentDateOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date((APPLE_EPOCH_SECONDS + value + 12 * 3600) * 1000).toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
  if (!m) return null;
  if (!m[2]) return m[1];
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return m[1];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The document date as the apps get it. Paperless-ngx always has one, and apps read it as a date
 * that cannot be empty (Swift Paperless fails on the whole list otherwise); a document without a
 * date shows the day it was added.
 */
export function shownCreated(d: Pick<ArchiveDocument, 'created' | 'created_date' | 'added' | 'modified'>, today = new Date()): string {
  const own = d.created ?? d.created_date;
  if (own) return own.slice(0, 10);
  for (const v of [d.added, d.modified]) if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return localDay(today);
}

export function ngxDocument(d: ArchiveDocument, version: number, opts: { content?: boolean; truncate?: boolean; fields?: string[] | null; perms?: boolean } = {}): Record<string, unknown> {
  const created = shownCreated(d);
  const isPdf = /pdf/i.test(d.mime_type ?? '');
  const out: Record<string, unknown> = {
    id: d.id,
    correspondent: d.correspondent ?? null,
    document_type: d.document_type ?? null,
    storage_path: null,
    title: d.title ?? '',
    content: opts.content === false ? '' : opts.truncate ? (d.content ?? '').slice(0, 300) : (d.content ?? ''),
    tags: d.tags ?? [],
    // Version 9 made `created` a date; before it was a date and time.
    created: version < 9 ? `${created}T12:00:00Z` : created,
    created_date: created,
    modified: d.modified ?? null,
    added: d.added ?? null,
    deleted_at: null,
    archive_serial_number: d.archive_serial_number ?? null,
    original_file_name: d.original_file_name ?? null,
    archived_file_name: isPdf ? (d.original_file_name ?? `${d.id}.pdf`) : null,
    owner: d.owner ?? null,
    user_can_change: d.user_can_change ?? true,
    is_shared_by_requester: false,
    notes: [],
    custom_fields: d.custom_fields ?? [],
    page_count: d.page_count ?? null,
    mime_type: d.mime_type ?? null,
  };
  if (opts.perms) out.permissions = { view: { users: [], groups: [] }, change: { users: [], groups: [] } };
  if (opts.fields?.length) {
    const keep = new Set(opts.fields);
    for (const k of Object.keys(out)) if (!keep.has(k)) delete out[k];
  }
  return out;
}

/** Lowercase name with dashes (Paperless-ngx sends a slug with every tag, correspondent and type). */
export function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Black or white text on a tag colour (as Paperless-ngx computes `text_color`). */
export function textColor(color: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color ?? '');
  if (!m) return '#000000';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.53 ? '#000000' : '#ffffff';
}

/**
 * Consumption tasks of Paperless-ngx have UUIDs (apps decode them as such): the intake attempt id
 * in a fixed UUID form, and back.
 */
export function taskIdOf(intakeId: number): string {
  return `00000000-0000-4000-8000-${intakeId.toString(16).padStart(12, '0')}`;
}

export function intakeIdOf(taskId: string): number | null {
  const m = /^00000000-0000-4000-8000-([0-9a-f]{12})$/i.exec(taskId.trim()) ?? /^intake-(\d+)$/.exec(taskId.trim());
  if (!m) return null;
  const n = m[0].startsWith('intake-') ? Number(m[1]) : parseInt(m[1], 16);
  return Number.isInteger(n) && n > 0 ? n : null;
}
