/**
 * Lexical helpers: tokenisation, stop words, FTS5 query construction and
 * snippet extraction.
 */
import { MONTHS } from '../processing/dates.js';

// Small multilingual stop word list (de, en, fr, es, it, nl) – enough to keep
// FTS queries focused on the meaningful words of a question.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by can could
did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in
into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same
she should so some such than that the their theirs them themselves then there these they this those through to too under until up
very was we were what when where which while who whom why will with would you your yours yourself yourselves please tell show find
give list get much many
aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes anders auch auf aus bei bin bis bist
da damit dann der den des dem die das dass daß du dein deine deinem deinen deiner deines denn derer dessen dich dir doch dort durch ein eine
einem einen einer eines einig einige einigem einigen einiger einiges einmal er ihn ihm es etwas euer eure eurem euren eurer eures
für gegen gewesen hab habe haben hat hatte hatten hier hin hinter ich mich mir ihr ihre ihrem ihren ihrer ihres euch im in indem ins
ist jede jedem jeden jeder jedes jene jenem jenen jener jenes jetzt kann kein keine keinem keinen keiner keines können könnte
machen man manche manchem manchen mancher manches mein meine meinem meinen meiner meines mit muss musste nach nicht nichts noch nun
nur ob oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie ihnen sind so solche solchem solchen solcher solches
soll sollte sondern sonst über um und uns unsere unserem unseren unser unseres unter viel vom von vor während war waren warst was
weg weil weiter welche welchem welchen welcher welches wenn werde werden wie wieder will wir wird wirst wo wollen wollte würde würden
zu zum zur zwar zwischen wann welcher wieviel wie viel viele bitte zeige zeig finde gib nenne liste habe hatte wurde wurden gibt
le la les un une des du de et est en au aux ce ces dans pour pas par sur qui que quoi avec son sa ses mon ma mes il elle nous vous ils
el los las una unos unas del al y o en por para con su sus es son que como
il lo gli una uno di da in con su per tra fra che è sono
de het een en van ik je hij zij wij jullie zij is zijn was op aan met voor`
    .split(/\s+/)
    .filter(Boolean),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFC').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).map((t) => t.replace(/['’-]+$/g, ''));
}

/** Meaningful search terms of a question (stop words removed, de-duplicated). */
export function queryTerms(text: string, max = 24): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokenize(text)) {
    const t = raw.replace(/['’]/g, '');
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// Inflection endings (German/English) removed before prefix search, longest first.
const SUFFIXES = ['ungen', 'ung', 'ern', 'en', 'er', 'es', 'em', 'e', 'n', 's'];

/**
 * Very light stemming for prefix queries: "Rechnungen" → "rechn", "Versicherungen" →
 * "versicher", "invoices" → "invoic". Only applied when a stem of ≥ 4 letters remains.
 */
export function stem(term: string): string {
  if (term.length < 6 || /\d/.test(term)) return term;
  for (const suffix of SUFFIXES) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 4) return term.slice(0, -suffix.length);
  }
  return term;
}

/**
 * Build a safe FTS5 MATCH expression: every term quoted (no syntax injection),
 * prefix search for longer words (helps with German compounds and inflections).
 */
export function buildFtsQuery(terms: string[]): string | null {
  const parts = [
    ...new Set(
      terms
        .map((t) => t.replace(/"/g, ''))
        .filter(Boolean)
        .map((t) => (t.length >= 4 && !/^\d+$/.test(t) ? `"${stem(t)}"*` : `"${t}"`)),
    ),
  ];
  return parts.length ? parts.join(' OR ') : null;
}

/** Pick the most relevant ~maxLen characters of a passage for display. */
export function makeSnippet(text: string, terms: string[], maxLen = 280): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const lower = clean.toLowerCase();
  let bestPos = 0;
  let bestScore = -1;
  // Score windows starting at term occurrences.
  for (const term of terms) {
    let idx = lower.indexOf(term);
    let guard = 0;
    while (idx >= 0 && guard++ < 20) {
      const start = Math.max(0, idx - 60);
      const window = lower.slice(start, start + maxLen);
      const score = terms.reduce((s, t) => s + (window.includes(t) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestPos = start;
      }
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  let start = bestPos;
  if (start > 0) {
    const space = clean.indexOf(' ', start);
    if (space > 0 && space - start < 20) start = space + 1;
  }
  let snippet = clean.slice(start, start + maxLen);
  const lastSpace = snippet.lastIndexOf(' ');
  if (start + maxLen < clean.length && lastSpace > maxLen * 0.8) snippet = snippet.slice(0, lastSpace);
  return `${start > 0 ? '…' : ''}${snippet}${start + snippet.length < clean.length ? '…' : ''}`;
}

/** Simple lexical relevance used to rank passages of a single document (document chat). */
export function overlapScore(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of terms) {
    let idx = lower.indexOf(t);
    let n = 0;
    while (idx >= 0 && n < 5) {
      n++;
      idx = lower.indexOf(t, idx + t.length);
    }
    if (n) score += 1 + Math.log(n);
  }
  return score / terms.length;
}

const RECENCY =
  /(?<!\p{L})(latest|last|newest|most recent|recent|current|letzte[nmrs]?|neueste[nmrs]?|aktuellste[nmrs]?|jüngste[nmrs]?|zuletzt|dernier|dernière|récent|último|última|ultimo|ultima|recente|laatste|nieuwste)(?!\p{L})/iu;

export function asksForRecency(question: string): boolean {
  return RECENCY.test(question);
}

/** Years mentioned in a question, e.g. "Steuer 2023" → [2023]. */
export function mentionedYears(question: string): number[] {
  const years = new Set<number>();
  for (const m of question.matchAll(/\b(19[7-9]\d|20\d\d)\b/g)) years.add(Number(m[1]));
  return [...years];
}

/**
 * Months mentioned together with a year, e.g. "März 2024", "March 2024", "Mar. 2024",
 * "03/2024", "2024-03" → [{ year: 2024, month: 3 }].
 */
export function mentionedMonths(question: string): { year: number; month: number }[] {
  const out = new Map<string, { year: number; month: number }>();
  const add = (year: number, month: number) => {
    if (month >= 1 && month <= 12 && year >= 1970 && year <= 2099) out.set(`${year}-${month}`, { year, month });
  };
  const q = question.toLowerCase();
  for (const m of q.matchAll(/(?<!\p{L})(\p{L}{3,10})\.?\s+(19[7-9]\d|20\d\d)\b/gu)) {
    const month = MONTHS[m[1]];
    if (month) add(Number(m[2]), month);
  }
  for (const m of q.matchAll(/\b(0?[1-9]|1[0-2])[/.](19[7-9]\d|20\d\d)\b/g)) add(Number(m[2]), Number(m[1]));
  for (const m of q.matchAll(/\b(19[7-9]\d|20\d\d)-(0[1-9]|1[0-2])\b/g)) add(Number(m[1]), Number(m[2]));
  return [...out.values()];
}
