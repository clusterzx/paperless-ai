/**
 * Suggestions of the AI for objects that mean the same (Tags & metadata → Find duplicates → "Ask
 * the AI"). Only the names are sent – sorted, in overlapping chunks, so neighbours like "1&1" and
 * "1und1" end up in the same request. The AI's groups are suggestions like the deterministic ones.
 */
import type { AppContext } from '../context.js';
import { extractJsonObject } from '../ai/json.js';
import { normalizeName } from './metadata.js';
import { pickKeep, type NamedItem, type SimilarGroup, type SimilarKind } from './similarNames.js';

const CHUNK = 400;
const OVERLAP = 40;
/** At most this many names per call (cost bound). */
export const MAX_AI_NAMES = 3000;

const WHAT: Record<SimilarKind, { list: string; entity: string; different: string }> = {
  correspondent: {
    list: 'correspondents (senders: companies, authorities, organisations, people)',
    entity: 'organisation or person',
    different: 'different organisations, separate branches or offices in different cities that are separate counterparts, or different people with similar names',
  },
  tag: { list: 'tags', entity: 'topic', different: 'related but different topics (e.g. "Car insurance" and "Car")' },
  documentType: { list: 'document types', entity: 'kind of document', different: 'related but different kinds (e.g. "Invoice" and "Reminder")' },
};

function system(kind: SimilarKind): string {
  const w = WHAT[kind];
  return `You clean up the metadata of a document archive. You get a list of ${w.list}, one per line.
Find names that denote the same ${w.entity}: spelling variants, legal forms, abbreviations, translations, singular/plural.
Do NOT group ${w.different}. When in doubt, leave names apart.
Answer only JSON: {"groups":[{"names":["…","…"],"canonical":"…"}]}
- names: at least two, copied exactly from the list
- canonical: the short common name (no legal form, as used in everyday language); it may be one of the names
- {"groups":[]} if there are none`;
}

interface AiAnswer {
  groups?: { names?: unknown; canonical?: unknown }[];
}

/** Groups the AI finds among the items (names matched back exactly). Records the token usage. */
export async function aiSimilarGroups(ctx: AppContext, items: NamedItem[], kind: SimilarKind, signal?: AbortSignal): Promise<{ groups: SimilarGroup[]; tokens: number }> {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_AI_NAMES);
  const byName = new Map(sorted.map((i) => [normalizeName(i.name), i]));
  const llm = ctx.llm();
  // Union of all groups over the chunks (a name can be in two overlapping chunks).
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    if (!parent.has(id)) parent.set(id, id);
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  /** Canonical name suggested for a group, stored at one of its members. */
  const canonical = new Map<number, string>();
  let tokens = 0;
  for (let start = 0; start < sorted.length; start += CHUNK - OVERLAP) {
    const chunk = sorted.slice(start, start + CHUNK);
    if (chunk.length < 2) break;
    const res = await llm.complete(
      [
        { role: 'system', content: system(kind) },
        { role: 'user', content: chunk.map((i) => i.name).join('\n') },
      ],
      { json: true, temperature: 0, maxTokens: 4000, signal, timeoutMs: 180_000 },
    );
    ctx.recordUsage('metadata', res);
    tokens += res.usage.totalTokens;
    let answer: AiAnswer;
    try {
      answer = extractJsonObject<AiAnswer>(res.text);
    } catch {
      continue;
    }
    for (const g of answer.groups ?? []) {
      if (!Array.isArray(g.names)) continue;
      const members = [...new Set(g.names.filter((n): n is string => typeof n === 'string').map((n) => byName.get(normalizeName(n))).filter((i): i is NamedItem => Boolean(i)))];
      if (members.length < 2) continue;
      for (const m of members.slice(1)) union(members[0].id, m.id);
      if (typeof g.canonical === 'string' && g.canonical.trim()) canonical.set(members[0].id, g.canonical.trim().slice(0, 128));
    }
    if (start + CHUNK >= sorted.length) break;
  }
  const groups = new Map<number, NamedItem[]>();
  for (const i of sorted) {
    if (!parent.has(i.id)) continue;
    const r = find(i.id);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const out: SimilarGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const name = members.map((m) => canonical.get(m.id)).find(Boolean);
    // Keep the member that already has the canonical name, else the best one (renamed to it).
    const keep = (name && members.find((m) => normalizeName(m.name) === normalizeName(name))) || pickKeep(members, kind);
    const ordered = [keep, ...members.filter((m) => m !== keep)];
    out.push({ ids: ordered.map((m) => m.id), names: ordered.map((m) => m.name), suggested: name || keep.name, keepId: keep.id, reason: 'ai' });
  }
  return { groups: out, tokens };
}
