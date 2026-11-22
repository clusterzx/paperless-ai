/**
 * Interprets the search syntax of the document list (src/shared/searchSyntax.ts) for a caller:
 * names of tags, correspondents, document types and libraries become ids of what the caller can
 * see, dates become ranges. The result is a structured DocumentFilter for both backends, plus what
 * each term was understood as (shown under the search box).
 */
import type { AppContext } from '../context.js';
import type { AccessScope } from '../access/scope.js';
import { canRead } from '../access/scope.js';
import type { DocumentFilter } from '../backend/types.js';
import { normalizeName } from '../backend/metadata.js';
import { basicKey } from '../backend/similarNames.js';
import { hasSearchSyntax, parseDateRange, parseSearch, type SearchTerm } from '../../shared/searchSyntax.js';
import type { SearchInterpretation } from '../../shared/api.js';

interface Named {
  id: number;
  name: string;
  document_count?: number;
}

/** Exact name first (case, accents and punctuation ignored), else every name containing the value. */
function matching(items: Named[], value: string): Named[] {
  const want = normalizeName(value);
  const exact = items.filter((i) => normalizeName(i.name) === want);
  if (exact.length) return exact;
  const loose = basicKey(value);
  if (!loose) return [];
  const exactLoose = items.filter((i) => basicKey(i.name) === loose);
  if (exactLoose.length) return exactLoose;
  return items.filter((i) => basicKey(i.name).includes(loose));
}

const byUse = (a: Named, b: Named) => (b.document_count ?? 0) - (a.document_count ?? 0) || a.name.localeCompare(b.name);

/** Nothing can match (a name that does not exist). */
const NOTHING = -1;

export async function applySearchSyntax(ctx: AppContext, scope: AccessScope, filter: DocumentFilter): Promise<{ filter: DocumentFilter; terms: SearchInterpretation[] }> {
  const input = filter.query;
  if (!input || !hasSearchSyntax(input)) return { filter, terms: [] };
  const parsed = parseSearch(input);
  const f: DocumentFilter = { ...filter };
  delete f.query;
  if (parsed.text) f.query = parsed.text;
  // Paperless-ngx leaves words out only next to words to search for, and not in the title alone.
  const builtin = ctx.archiveMode() === 'builtin';
  const excludable = builtin || Boolean(parsed.text);
  if (parsed.exclude.length && excludable) f.notQuery = parsed.exclude.join(' ');

  // Names of what the caller can see (ids are unique across libraries).
  const backend = ctx.backend(scope);
  const snaps = await Promise.all((await backend.metadataScopes()).map((lib) => ctx.metadata(lib).snapshot()));
  const names = {
    tag: snaps.flatMap((s) => s.tags),
    correspondent: snaps.flatMap((s) => s.correspondents),
    type: snaps.flatMap((s) => s.documentTypes),
  };
  const terms: SearchInterpretation[] = [];
  if (parsed.exclude.length && !excludable) {
    for (const w of parsed.exclude) terms.push({ key: 'text', value: w, negate: true, matched: [], problem: 'With Paperless-ngx, words can only be left out next to words to search for' });
  }
  const nothing = () => {
    f.ids = [NOTHING];
  };
  const range = (t: SearchTerm, fromKey: 'createdFrom' | 'addedFrom', toKey: 'createdTo' | 'addedTo') => {
    const r = parseDateRange(t.value);
    if (!r) {
      terms.push({ ...t, matched: [], problem: `Not a date: ${t.value} (e.g. 2024, 2024-03, >2024-01-01, 2023..2024)` });
      return;
    }
    // Several ranges: all of them (the overlap).
    if (r.from && (!f[fromKey] || r.from > f[fromKey]!)) f[fromKey] = r.from;
    if (r.to && (!f[toKey] || r.to < f[toKey]!)) f[toKey] = r.to;
    terms.push({ ...t, matched: [`${r.from ?? '…'} – ${r.to ?? '…'}`] });
  };

  const tagIds: number[] = [];
  for (const t of parsed.terms) {
    switch (t.key) {
      case 'title':
        if (t.negate && !builtin) {
          terms.push({ ...t, matched: [], problem: 'Leaving out title words needs the built-in archive' });
          break;
        }
        if (t.negate) f.notTitle = [f.notTitle, t.value].filter(Boolean).join(' ');
        else f.titleQuery = [f.titleQuery, t.value].filter(Boolean).join(' ');
        terms.push({ ...t, matched: [t.value] });
        break;
      case 'text':
        if (t.negate && !excludable) {
          terms.push({ ...t, matched: [], problem: 'With Paperless-ngx, words can only be left out next to words to search for' });
          break;
        }
        if (t.negate) f.notQuery = [f.notQuery, t.value].filter(Boolean).join(' ');
        else f.contentQuery = [f.contentQuery, t.value].filter(Boolean).join(' ');
        terms.push({ ...t, matched: [t.value] });
        break;
      case 'tag': {
        const found = matching(names.tag, t.value).sort(byUse);
        if (!found.length) {
          terms.push({ ...t, matched: [], problem: `No tag “${t.value}”` });
          if (!t.negate) nothing();
        } else if (t.negate) {
          f.tagsNone = [...new Set([...(f.tagsNone ?? []), ...found.map((x) => x.id)])];
          terms.push({ ...t, matched: found.map((x) => x.name) });
        } else {
          // Every tag term must match: one tag each – the exact one, else the most used.
          tagIds.push(found[0].id);
          terms.push({ ...t, matched: [found[0].name] });
        }
        break;
      }
      case 'correspondent':
      case 'type': {
        const found = matching(t.key === 'type' ? names.type : names.correspondent, t.value).sort(byUse);
        const label = t.key === 'type' ? 'document type' : 'correspondent';
        if (!found.length) {
          terms.push({ ...t, matched: [], problem: `No ${label} “${t.value}”` });
          if (!t.negate) nothing();
          break;
        }
        const ids = found.map((x) => x.id);
        terms.push({ ...t, matched: found.map((x) => x.name) });
        const none = t.key === 'type' ? 'documentTypesNone' : 'correspondentsNone';
        const any = t.key === 'type' ? 'documentTypes' : 'correspondents';
        if (t.negate) f[none] = [...new Set([...(f[none] ?? []), ...ids])];
        else {
          // Already restricted (filter panel or another term): both must hold.
          const prev = f[any];
          const next = prev?.length ? prev.filter((id) => ids.includes(id)) : ids;
          f[any] = next.length ? next : [NOTHING];
        }
        break;
      }
      case 'created':
        range(t, 'createdFrom', 'createdTo');
        break;
      case 'added':
        range(t, 'addedFrom', 'addedTo');
        break;
      case 'asn': {
        const n = Number(t.value.replace(/^asn/i, ''));
        if (!Number.isInteger(n) || n < 0) terms.push({ ...t, matched: [], problem: `Not a number: ${t.value}` });
        else {
          f.asn = n;
          terms.push({ ...t, matched: [String(n)] });
        }
        break;
      }
      case 'id': {
        const ids = t.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) terms.push({ ...t, matched: [], problem: `Not an id: ${t.value}` });
        else {
          f.ids = f.ids?.length ? f.ids.filter((x) => ids.includes(x)) : ids;
          if (!f.ids.length) nothing();
          terms.push({ ...t, matched: ids.map(String) });
        }
        break;
      }
      case 'library': {
        if (!backend.capabilities.libraries) {
          terms.push({ ...t, matched: [], problem: 'Libraries exist in the built-in archive only' });
          break;
        }
        const libs = ctx.repos.libraries.list().filter((l) => canRead(scope, l.id));
        const found = matching(libs, t.value);
        if (!found.length) {
          terms.push({ ...t, matched: [], problem: `No library “${t.value}”` });
          nothing();
        } else {
          const ids = found.map((l) => l.id);
          f.libraryIds = f.libraryIds?.length ? f.libraryIds.filter((x) => ids.includes(x)) : ids;
          if (!f.libraryIds.length) nothing();
          terms.push({ ...t, matched: found.map((l) => l.name) });
        }
        break;
      }
    }
  }
  if (tagIds.length) f.tagsAll = [...new Set([...(f.tagsAll ?? []), ...tagIds])];
  return { filter: f, terms };
}
