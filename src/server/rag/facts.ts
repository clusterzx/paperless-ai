/**
 * Exact numbers for counting questions ("How many invoices from ACME in 2024?").
 *
 * The chat only sees excerpts of the best-matching documents, so the model
 * cannot count documents itself. For such questions, the tags, correspondents
 * and document types named in the question are looked up and the archive counts
 * the matching documents.
 */
import type { AppContext } from '../context.js';
import type { AccessScope } from '../access/scope.js';
import type { DocumentFilter } from '../backend/types.js';
import { normalizeName } from '../backend/metadata.js';
import { mentionedMonths, mentionedYears } from './text.js';

/** "How many …" in the languages Paperless users write most. */
const COUNT_QUESTION =
  /(?<![\p{L}])(how many|number of|count|wie ?viele?|anzahl|combien|nombre de|cu[aá]nt[oa]s|quant[ie]|hoeveel|ile)(?![\p{L}])/iu;

export function isCountQuestion(question: string): boolean {
  return COUNT_QUESTION.test(question);
}

/** Names that occur in the question as words (also in simple plural forms: invoice → invoices, Rechnung → Rechnungen). */
export function mentionedNames<T extends { name: string }>(question: string, items: T[]): T[] {
  const text = normalizeName(question);
  return items.filter((item) => {
    const name = normalizeName(item.name);
    if (name.length < 3) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:s|es|en|e|n)?(?![\\p{L}\\p{N}])`, 'iu').test(text);
  });
}

/**
 * Archive facts for a counting question as text for the prompt, or null when the question does not
 * ask for a number. Never throws: without facts the model falls back to the excerpts.
 * Counted per metadata namespace (one for Paperless-ngx, one per library of the built-in archive).
 */
export async function archiveFacts(ctx: AppContext, question: string, scope?: AccessScope): Promise<string | null> {
  if (!isCountQuestion(question)) return null;
  try {
    const backend = ctx.backend(scope);
    const years = mentionedYears(question);
    const months = mentionedMonths(question);
    const lines = [`- Documents in the archive: ${await backend.countDocuments()}`];
    const perName = new Map<string, { label: string; count: number }>();
    const criteria = new Set<string>();
    let combined = 0;
    let hasCombined = false;

    for (const lib of await backend.metadataScopes()) {
      const meta = await ctx.metadata(lib).snapshot();
      const tags = mentionedNames(question, meta.tags);
      const correspondents = mentionedNames(question, meta.correspondents);
      const types = mentionedNames(question, meta.documentTypes);
      const note = (key: string, label: string, n: number | undefined) => {
        const e = perName.get(key) ?? { label, count: 0 };
        e.count += n ?? 0;
        perName.set(key, e);
      };
      for (const t of tags) note(`t:${normalizeName(t.name)}`, `Tag "${t.name}"`, t.document_count);
      for (const c of correspondents) note(`c:${normalizeName(c.name)}`, `Correspondent "${c.name}"`, c.document_count);
      for (const d of types) note(`d:${normalizeName(d.name)}`, `Document type "${d.name}"`, d.document_count);

      // All criteria together (one correspondent/type – a document has only one).
      const filter: DocumentFilter = lib != null ? { libraryIds: [lib] } : {};
      const parts: string[] = [];
      if (tags.length) {
        filter.tagsAll = tags.map((t) => t.id);
        parts.push(tags.map((t) => `tag "${t.name}"`).join(' + '));
      }
      if (correspondents.length === 1) {
        filter.correspondent = correspondents[0].id;
        parts.push(`correspondent "${correspondents[0].name}"`);
      }
      if (types.length === 1) {
        filter.documentType = types[0].id;
        parts.push(`document type "${types[0].name}"`);
      }
      if (months.length === 1) {
        filter.createdYear = months[0].year;
        filter.createdMonth = months[0].month;
        parts.push(`created in ${months[0].year}-${String(months[0].month).padStart(2, '0')}`);
      } else if (years.length === 1) {
        filter.createdYear = years[0];
        parts.push(`created in ${years[0]}`);
      }
      const single = parts.length === 1 && tags.length <= 1 && !filter.createdYear;
      if (parts.length && !single) {
        hasCombined = true;
        parts.forEach((p) => criteria.add(p));
        combined += await backend.countDocuments(filter);
      }
    }
    for (const { label, count } of perName.values()) lines.push(`- ${label}: ${count} documents`);
    if (hasCombined) lines.push(`- Documents with ${[...criteria].join(', ')}: ${combined}`);
    return lines.join('\n');
  } catch {
    return null;
  }
}
