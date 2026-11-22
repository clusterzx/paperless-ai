/**
 * Finds tags, correspondents and document types that most likely mean the same – "ABUniverse" and
 * "Abuniverse Europe", "ADAC Versicherung" and "ADAC Versicherung AG", "Rechnung" and "Rechnungen" –
 * so they can be merged. Deterministic and cheap (no AI): the result is a list of suggestions the
 * user confirms or dismisses.
 *
 * Rules (union of all matches):
 * - same: the same name ignoring case, umlauts/accents, punctuation and – for correspondents – legal
 *   forms (GmbH, AG, SE, & Co. KG, S.à r.l., Inc …) and region / branch words at the end (Europe,
 *   Deutschland, EU, Germany, International, Gruppe …);
 * - spelling: one word differs by one letter (typo, "Telecom"/"Telekom") or by a plural ending
 *   ("Rechnung"/"Rechnungen");
 * - extends (to check, never mixed into the groups above): one correspondent name continues the
 *   other ("Sparkasse" → "Sparkasse KölnBonn") – only when there is exactly one such continuation,
 *   so "Stadtwerke Köln" and "Stadtwerke München" are not thrown together through "Stadtwerke". It
 *   is often right, but "ADAC" and "ADAC Versicherung" are two companies: a separate suggestion.
 */

export type SimilarKind = 'tag' | 'correspondent' | 'documentType';

export interface NamedItem {
  id: number;
  name: string;
  document_count?: number;
}

export type SimilarReason = 'same' | 'extends' | 'spelling' | 'ai';

export interface SimilarGroup {
  /** The objects of the group, the one to keep first. */
  ids: number[];
  names: string[];
  /** Suggested name of the merged object (the name of the one to keep). */
  suggested: string;
  keepId: number;
  reason: SimilarReason;
}

const LEGAL = new Set([
  'gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'gbr', 'ug', 'ev', 'eg', 'co', 'cokg', 'haftungsbeschraenkt',
  'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'plc', 'corp', 'corporation', 'company',
  'sarl', 'sa', 'sas', 'srl', 'spa', 'bv', 'nv', 'ab', 'as', 'asa', 'oy', 'oyj', 'aps', 'kft', 'sro', 'spzoo',
]);
const REGION = new Set([
  'deutschland', 'germany', 'german', 'europe', 'european', 'europa', 'eu', 'international', 'intl', 'dach',
  'gruppe', 'group', 'holding', 'niederlassung', 'zweigniederlassung', 'branch', 'filiale',
]);

/** Lower case, umlauts as ae/oe/ue, no accents, "&"/"and"/"und" alike, no punctuation. */
export function basicKey(name: string): string {
  let s = name.normalize('NFC').toLowerCase();
  s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s.normalize('NFKD').replace(/\p{M}/gu, '');
  // Dotted legal forms first, so they survive the punctuation step as one word.
  s = s.replace(/\bs\.?\s?a\.?\s?r\.?\s?l\b\.?/g, ' sarl ').replace(/\bsp\.?\s?z\s?o\.?\s?o\b\.?/g, ' spzoo ').replace(/\bs\.\s?r\.\s?o\b\.?/g, ' sro ');
  s = s.replace(/\b([a-z])\.(?=[a-z]\b\.?)/g, '$1'); // e.V. → ev, e.G. → eg
  s = s.replace(/&/g, ' und ').replace(/\+/g, ' und ');
  s = s.replace(/[.'’`´]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s
    .split(' ')
    .filter(Boolean)
    .map((t) => (t === 'and' ? 'und' : t))
    .join(' ');
}

/** The key two names of the same entity share. Correspondents lose legal forms and region words at the end. */
export function entityKey(name: string, kind: SimilarKind): string {
  const tokens = basicKey(name).split(' ').filter(Boolean);
  if (kind !== 'correspondent') return tokens.join(' ');
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    if (LEGAL.has(last) || REGION.has(last)) {
      tokens.pop();
      changed = true;
    } else if (last === 'und' || last === 'cie') {
      // "… & Co." / "… & Cie." remnants
      tokens.pop();
      changed = true;
    }
  }
  return tokens.join(' ');
}

/** Plural and inflection endings away (German / English), for tags and document types. */
function stem(word: string): string {
  for (const end of ['en', 'er', 'e', 'n', 's']) {
    if (word.endsWith(end) && word.length - end.length >= 4) return word.slice(0, -end.length);
  }
  return word;
}

/** Damerau-Levenshtein distance ≤ 1 (one insertion, deletion, substitution or swap). */
export function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

class UnionFind {
  private readonly parent: number[];
  readonly reason: SimilarReason[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.reason = Array.from({ length: n }, () => 'same' as SimilarReason);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number, reason: SimilarReason): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent[rb] = ra;
    // The weakest reason of a group is shown ("spelling" < "extends" < "same").
    const rank = { same: 0, extends: 1, spelling: 2, ai: 3 };
    const worst = [this.reason[ra], this.reason[rb], reason].sort((x, y) => rank[y] - rank[x])[0];
    this.reason[ra] = worst;
  }
}

/** The object to keep: a clean name (no legal form / region word) first, then the most used, then the shortest. */
export function pickKeep<T extends NamedItem>(items: T[], kind: SimilarKind): T {
  const clean = (i: T) => (basicKey(i.name) === entityKey(i.name, kind) ? 0 : 1);
  return [...items].sort((a, b) => clean(a) - clean(b) || (b.document_count ?? 0) - (a.document_count ?? 0) || a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
}

/** Groups of objects that probably mean the same (each group ≥ 2 objects). */
export function similarGroups(items: NamedItem[], kind: SimilarKind): SimilarGroup[] {
  const n = items.length;
  const uf = new UnionFind(n);
  const keys = items.map((i) => entityKey(i.name, kind));
  const tokens = keys.map((k) => k.split(' ').filter(Boolean));

  // same
  const byKey = new Map<string, number[]>();
  keys.forEach((k, i) => {
    if (!k) return;
    const list = byKey.get(k) ?? [];
    list.push(i);
    byKey.set(k, list);
  });
  for (const list of byKey.values()) for (const j of list.slice(1)) uf.union(list[0], j, 'same');

  // spelling: same number of words, one word differs by one letter (long enough) or by its ending
  const minLength = kind === 'correspondent' ? 6 : 5;
  const buckets = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    if (!t.length) return;
    for (let w = 0; w < t.length; w++) {
      const sig = `${t.length}|${w}|${t.map((x, j) => (j === w ? '*' : x)).join(' ')}`;
      const list = buckets.get(sig) ?? [];
      list.push(i);
      buckets.set(sig, list);
    }
  });
  for (const [sig, list] of buckets) {
    if (list.length < 2) continue;
    const w = Number(sig.split('|')[1]);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const x = tokens[list[a]][w];
        const y = tokens[list[b]][w];
        if (x === y) continue;
        const typo = Math.min(x.length, y.length) >= minLength && withinOne(x, y) && !/\d/.test(x + y);
        const plural = kind !== 'correspondent' && stem(x) === stem(y);
        if (typo || plural) uf.union(list[a], list[b], 'spelling');
      }
    }
  }

  // extends (correspondents): "a b" → "a b c", only if "a b" has exactly one continuation – kept
  // apart: a suggestion of its own over both groups, never merged into them.
  const extendPairs: [number, number][] = [];
  if (kind === 'correspondent') {
    const continuations = new Map<string, Set<string>>();
    for (const k of byKey.keys()) {
      const t = k.split(' ');
      for (let len = 1; len < t.length; len++) {
        const prefix = t.slice(0, len).join(' ');
        if (!byKey.has(prefix)) continue;
        const set = continuations.get(prefix) ?? new Set<string>();
        set.add(k);
        continuations.set(prefix, set);
      }
    }
    for (const [prefix, set] of continuations) {
      if (set.size !== 1 || prefix.replace(/ /g, '').length < 4 || !prefix.split(' ').some((t) => t.length >= 3)) continue;
      const [longer] = [...set];
      extendPairs.push([byKey.get(prefix)![0], byKey.get(longer)![0]]);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    const list = groups.get(r) ?? [];
    list.push(i);
    groups.set(r, list);
  }
  const group = (members: number[], reason: SimilarReason): SimilarGroup => {
    const list = members.map((i) => items[i]);
    const keep = pickKeep(list, kind);
    const ordered = [keep, ...list.filter((i) => i !== keep).sort((a, b) => (b.document_count ?? 0) - (a.document_count ?? 0) || a.name.localeCompare(b.name))];
    return { ids: ordered.map((i) => i.id), names: ordered.map((i) => i.name), suggested: keep.name, keepId: keep.id, reason };
  };
  const strong: SimilarGroup[] = [];
  for (const [root, members] of groups) if (members.length >= 2) strong.push(group(members, uf.reason[root]));
  // "extends": both groups (or single names) together, as one suggestion to check.
  const weak = extendPairs.filter(([a, b]) => uf.find(a) !== uf.find(b)).map(([a, b]) => group([...groups.get(uf.find(a))!, ...groups.get(uf.find(b))!], 'extends'));
  // Certain ones first, most documents affected first.
  const count = new Map(items.map((i) => [i.id, i.document_count ?? 0]));
  const docs = (g: SimilarGroup) => g.ids.reduce((s, id) => s + (count.get(id) ?? 0), 0);
  const order = (a: SimilarGroup, b: SimilarGroup) => docs(b) - docs(a) || a.suggested.localeCompare(b.suggested);
  return [...strong.sort(order), ...weak.sort(order)];
}
