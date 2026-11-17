/**
 * Prompt wizard: turns the user's answers into a system prompt. Shared by the
 * web UI (live preview) and the server, so the preview is exactly what is
 * saved. The JSON output format is not part of it – the server appends it to
 * every prompt (src/server/processing/prompt.ts).
 */
import type { PromptWizardAnswers } from '../server/config/schema.js';

export type { PromptWizardAnswers };

export const WIZARD_LANGUAGES = ['German', 'English', 'French', 'Spanish', 'Italian', 'Dutch', 'Portuguese', 'Polish', 'Swedish', 'Danish', 'Czech', 'Turkish'];

export const TAG_AVOID_LABELS: Record<PromptWizardAnswers['tagAvoid'][number], string> = {
  years: 'Years and dates (“2024”)',
  correspondents: 'The correspondent (“Amazon”)',
  documentTypes: 'The document type (“Invoice”)',
  generic: 'Meaningless tags (“Document”, “Scan”, “Misc”)',
};

/** Placeholders of the title pattern and what they mean. */
export const TITLE_PLACEHOLDERS: Record<string, string> = {
  '{correspondent}': 'sender in short form',
  '{type}': 'document type',
  '{subject}': 'what the document is about, in a few words',
  '{date}': 'month and year of the document',
  '{reference}': 'invoice, policy, contract or customer number',
};

function list(items: string[]): string {
  return items.map((i) => `“${i}”`).join(', ');
}

/** The system prompt for the given answers. */
export function buildWizardPrompt(a: PromptWizardAnswers): string {
  const out: string[] = [];
  const archive = a.context.trim() ? ` The archive: ${a.context.trim().replace(/\.?$/, '.')}` : '';
  out.push(`You are an assistant that files documents in a personal document archive (Paperless-ngx).${archive}`);
  out.push('Read the document and determine the information requested below. Base everything on the document itself – do not guess.');

  if (a.owners.length) {
    out.push(
      [
        'Owner of the archive:',
        `- The archive belongs to ${list(a.owners)}. Documents are usually addressed TO them: never use them as correspondent, tag or title.`,
        '- If the owner wrote the document (e.g. an outgoing letter or own invoice), the correspondent is the other party.',
      ].join('\n'),
    );
  }

  const language = a.language === 'fixed' && a.fixedLanguage.trim() ? a.fixedLanguage.trim() : null;
  out.push(
    [
      'Language:',
      language
        ? `- Write title, tags and document type in ${language}, even when the document is written in another language. Names of companies and products stay as they are.`
        : '- Write title, tags and document type in the language of the document.',
    ].join('\n'),
  );

  const title: string[] = ['Title:'];
  if (a.titleStyle === 'pattern') {
    const used = Object.entries(TITLE_PLACEHOLDERS).filter(([k]) => a.titlePattern.includes(k));
    title.push(`- Build the title exactly like this: ${a.titlePattern.trim()}`);
    if (used.length) title.push(`  Placeholders: ${used.map(([k, v]) => `${k} = ${v}`).join('; ')}. Leave out parts that are unknown, without leftover separators.`);
  } else if (a.titleStyle === 'short') {
    title.push('- A very short title of 2 to 5 words that names what the document is.');
  } else {
    title.push('- A concise, descriptive title that says what the document is about, e.g. “Electricity bill October 2026” or “Car insurance policy renewal”.');
  }
  if (a.titleStyle !== 'pattern') {
    if (a.titleReference) title.push('- Include invoice, order, policy, contract or customer numbers when the document has one.');
    title.push(a.titleDate ? '- Include month and year of the document (e.g. “October 2026”).' : '- Do not put dates into the title – the document date is stored separately.');
  }
  title.push(`- At most ${a.titleMaxLength} characters. No addresses, file names or generic words such as “Scan” or “Document”.`);
  out.push(title.join('\n'));

  const tags: string[] = ['Tags:'];
  tags.push(a.maxTags === 1 ? '- Assign exactly 1 tag.' : `- Assign 1 to ${a.maxTags} tags – fewer is better than vague ones.`);
  if (a.tagStyle === 'broad') tags.push('- Use broad, reusable categories (like folders), e.g. “Insurance”, “Taxes”, “Car”, “Health”, “Home”.');
  else if (a.tagStyle === 'specific') tags.push('- Use specific tags that describe the topic precisely.');
  else tags.push('- Combine one broad category (e.g. “Insurance”, “Taxes”) with a more specific topic where it helps.');
  const avoid: Record<string, string> = {
    years: '- No tags for years or dates.',
    correspondents: '- Do not repeat the correspondent as a tag.',
    documentTypes: '- Do not repeat the document type as a tag.',
    generic: '- No meaningless tags such as “Document”, “Scan”, “Important” or “Misc”.',
  };
  for (const k of a.tagAvoid) tags.push(avoid[k]);
  out.push(tags.join('\n'));

  const corr: string[] = ['Correspondent:'];
  corr.push('- The sender or issuer of the document (company, authority, organisation or person) – not the recipient.');
  if (a.correspondentShort) corr.push('- Use the shortest common name, e.g. “Amazon” instead of “Amazon EU S.à r.l., German branch”; no address and no legal form unless it is needed to tell two apart.');
  if (!a.correspondentPersons) corr.push('- Only companies, authorities and organisations: leave it empty when the sender is a private person.');
  out.push(corr.join('\n'));

  const type: string[] = ['Document type:'];
  type.push('- A precise but general type that many documents share – not a description of this one document.');
  if (a.documentTypes.length) type.push(`- Prefer one of these types: ${list(a.documentTypes)}.`);
  out.push(type.join('\n'));

  const extra = a.extra
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (extra.length) out.push(['Additional rules:', ...extra.map((l) => (l.startsWith('-') ? l : `- ${l}`))].join('\n'));

  return out.join('\n\n');
}

/** Output language for title, tags and document type (null = the language of the document). */
export function wizardLanguage(a: PromptWizardAnswers): string | null {
  return a.used && a.language === 'fixed' && a.fixedLanguage.trim() ? a.fixedLanguage.trim() : null;
}
