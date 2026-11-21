/**
 * Search syntax of the document list: free words plus `key:value` terms, as in modern web apps.
 *
 *   rechnung title:"Strom 2024" tag:steuer -tag:erledigt correspondent:adac created:2024 asn:17
 *
 * Shared by the server (which resolves names to ids) and the browser (autocomplete, help).
 */

export type SearchKey = 'title' | 'text' | 'correspondent' | 'tag' | 'type' | 'created' | 'added' | 'asn' | 'id' | 'library';

export interface SearchKeyInfo {
  key: SearchKey;
  /** Spellings that mean this key (the first one is shown). */
  aliases: string[];
  example: string;
  description: string;
  /** Values come from these names (autocomplete). */
  values?: 'tags' | 'correspondents' | 'documentTypes' | 'libraries';
  negatable?: boolean;
}

export const SEARCH_KEYS: SearchKeyInfo[] = [
  { key: 'title', aliases: ['title', 'titel'], example: 'title:"Strom 2024"', description: 'Words in the title', negatable: true },
  { key: 'text', aliases: ['text', 'content', 'body', 'inhalt'], example: 'text:kündigung', description: 'Words in the text of the document', negatable: true },
  { key: 'correspondent', aliases: ['correspondent', 'from', 'sender', 'von', 'korrespondent'], example: 'correspondent:adac', description: 'Correspondent (part of the name is enough)', values: 'correspondents', negatable: true },
  { key: 'tag', aliases: ['tag', 'tags'], example: 'tag:steuer', description: 'Has this tag (each tag: all must match)', values: 'tags', negatable: true },
  { key: 'type', aliases: ['type', 'doctype', 'documenttype', 'typ', 'dokumenttyp'], example: 'type:rechnung', description: 'Document type', values: 'documentTypes', negatable: true },
  { key: 'created', aliases: ['created', 'date', 'datum', 'erstellt'], example: 'created:2024-03', description: 'Document date: 2024, 2024-03, 2024-03-15, >2024-01-01, 2023..2024' },
  { key: 'added', aliases: ['added', 'hinzugefuegt', 'hinzugefügt'], example: 'added:>2025-01-01', description: 'Added to the archive (same forms as created)' },
  { key: 'asn', aliases: ['asn'], example: 'asn:17', description: 'Archive serial number' },
  { key: 'id', aliases: ['id'], example: 'id:120,121', description: 'Document ids' },
  { key: 'library', aliases: ['library', 'lib', 'bibliothek'], example: 'library:familie', description: 'Library (built-in archive)', values: 'libraries', negatable: false },
];

const ALIAS = new Map(SEARCH_KEYS.flatMap((k) => k.aliases.map((a) => [a, k.key] as const)));

export interface SearchTerm {
  key: SearchKey;
  value: string;
  negate: boolean;
}

export interface ParsedSearch {
  /** Free words and "phrases" (for the full text search), in the original order. */
  text: string;
  /** Words to exclude (-word). */
  exclude: string[];
  terms: SearchTerm[];
}

interface Token {
  start: number;
  end: number;
  negate: boolean;
  /** Known key (lower case, resolved alias). */
  key?: SearchKey;
  /** The key as typed (also unknown ones). */
  keyText?: string;
  value: string;
  quoted: boolean;
  raw: string;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;
    const start = i;
    let negate = false;
    if (input[i] === '-' && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      negate = true;
      i++;
    }
    let keyText: string | undefined;
    const m = /^([\p{L}_]+):/u.exec(input.slice(i));
    if (m) {
      keyText = m[1];
      i += m[0].length;
    }
    let value: string;
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      const close = input.indexOf('"', i + 1);
      value = input.slice(i + 1, close < 0 ? input.length : close);
      i = close < 0 ? input.length : close + 1;
    } else {
      const s = i;
      while (i < input.length && !/\s/.test(input[i])) i++;
      value = input.slice(s, i);
    }
    const key = keyText ? ALIAS.get(keyText.toLowerCase()) : undefined;
    out.push({ start, end: i, negate, key, keyText, value, quoted, raw: input.slice(start, i) });
  }
  return out;
}

/** Split a search into free text, excluded words and key:value terms. Unknown keys stay text ("http://…"). */
export function parseSearch(input: string): ParsedSearch {
  const text: string[] = [];
  const exclude: string[] = [];
  const terms: SearchTerm[] = [];
  for (const t of tokenize(input)) {
    if (t.key) {
      if (t.value.trim()) terms.push({ key: t.key, value: t.value.trim(), negate: t.negate });
      continue;
    }
    const word = t.keyText ? `${t.keyText}:${t.value}` : t.value;
    if (!word.trim()) continue;
    if (t.negate) exclude.push(word);
    else text.push(t.quoted && !t.keyText ? `"${word}"` : word);
  }
  return { text: text.join(' '), exclude, terms };
}

/** Whether the search uses the syntax (then the server interprets it). */
export function hasSearchSyntax(input: string): boolean {
  return tokenize(input).some((t) => t.key || (t.negate && t.value));
}

/** The token at the cursor (autocomplete): its key, the value typed so far and where it is. */
export function tokenAt(input: string, cursor: number): { start: number; end: number; negate: boolean; key?: SearchKey; keyText?: string; value: string } | null {
  const t = tokenize(input).find((x) => cursor >= x.start && cursor <= x.end);
  if (!t) return null;
  return { start: t.start, end: t.end, negate: t.negate, key: t.key, keyText: t.keyText, value: t.value };
}

/** A value for the search: quoted when it has spaces or quotes are needed. */
export function searchValue(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

// ------------------------------------------------------------------ dates

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First and last day of a year, month or day: 2024, 2024-03, 2024-03-15, 15.03.2024, 03.2024. */
function period(v: string): { from: string; to: string } | null {
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(v))) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(v)) || (m = /^(\d{1,2})[./](\d{4})$/.exec(v))) {
    const [y, mo] = m[1].length === 4 ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
    if (mo < 1 || mo > 12) return null;
    return { from: iso(y, mo, 1), to: iso(y, mo, lastDay(y, mo)) };
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)) || (m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v))) {
    const [y, mo, d] = m[1].length === 4 ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
    if (mo < 1 || mo > 12 || d < 1 || d > lastDay(y, mo)) return null;
    const day = iso(y, mo, d);
    return { from: day, to: day };
  }
  return null;
}

/** Date range of a created:/added: value; null when it cannot be read. `to` is inclusive. */
export function parseDateRange(value: string, today = new Date()): { from?: string; to?: string } | null {
  const v = value.trim().toLowerCase();
  const todayIso = today.toISOString().slice(0, 10);
  if (v === 'today' || v === 'heute') return { from: todayIso, to: todayIso };
  if (v === 'yesterday' || v === 'gestern') return { from: shift(todayIso, -1), to: shift(todayIso, -1) };
  let m: RegExpExecArray | null;
  if ((m = /^(>=|<=|>|<)(.+)$/.exec(v))) {
    const p = period(m[2]);
    if (!p) return null;
    if (m[1] === '>') return { from: shift(p.to, 1) };
    if (m[1] === '>=') return { from: p.from };
    if (m[1] === '<') return { to: shift(p.from, -1) };
    return { to: p.to };
  }
  if ((m = /^(.*)\.\.(.*)$/.exec(v))) {
    const a = m[1] ? period(m[1]) : null;
    const b = m[2] ? period(m[2]) : null;
    if ((m[1] && !a) || (m[2] && !b) || (!a && !b)) return null;
    return { ...(a ? { from: a.from } : {}), ...(b ? { to: b.to } : {}) };
  }
  return period(v);
}
