/**
 * Exact numbers for counting questions ("How many invoices from ACME in 2024?").
 *
 * The chat only sees excerpts of the best-matching documents, so the model
 * cannot count documents itself. For such questions, the tags, correspondents
 * and document types named in the question are looked up and Paperless counts
 * the matching documents.
 */
import type { AppContext } from '../context.js';
import { normalizeName } from '../paperless/metadata.js';
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
 */
export async function archiveFacts(ctx: AppContext, question: string): Promise<string | null> {
  if (!isCountQuestion(question)) return null;
  try {
    const client = ctx.paperless();
    const meta = await ctx.metadata().snapshot();
    const tags = mentionedNames(question, meta.tags);
    const correspondents = mentionedNames(question, meta.correspondents);
    const types = mentionedNames(question, meta.documentTypes);
    const years = mentionedYears(question);
    const months = mentionedMonths(question);

    const lines = [`- Documents in the archive: ${await client.count('/documents/')}`];
    for (const t of tags) lines.push(`- Tag "${t.name}": ${t.document_count ?? '?'} documents`);
    for (const c of correspondents) lines.push(`- Correspondent "${c.name}": ${c.document_count ?? '?'} documents`);
    for (const d of types) lines.push(`- Document type "${d.name}": ${d.document_count ?? '?'} documents`);

    // All criteria together, counted by Paperless (one correspondent/type – a document has only one).
    const criteria: string[] = [];
    const query: Record<string, string | number> = {};
    if (tags.length) {
      query.tags__id__all = tags.map((t) => t.id).join(',');
      criteria.push(tags.map((t) => `tag "${t.name}"`).join(' + '));
    }
    if (correspondents.length === 1) {
      query.correspondent__id = correspondents[0].id;
      criteria.push(`correspondent "${correspondents[0].name}"`);
    }
    if (types.length === 1) {
      query.document_type__id = types[0].id;
      criteria.push(`document type "${types[0].name}"`);
    }
    if (months.length === 1) {
      query.created__year = months[0].year;
      query.created__month = months[0].month;
      criteria.push(`created in ${months[0].year}-${String(months[0].month).padStart(2, '0')}`);
    } else if (years.length === 1) {
      query.created__year = years[0];
      criteria.push(`created in ${years[0]}`);
    }
    const single = criteria.length === 1 && tags.length <= 1 && !query.created__year;
    if (criteria.length && !single) lines.push(`- Documents with ${criteria.join(', ')}: ${await client.count('/documents/', query)}`);
    return lines.join('\n');
  } catch {
    return null;
  }
}
