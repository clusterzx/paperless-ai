/**
 * Prompt construction for document analysis.
 *
 * The output contract (JSON fields) is generated from the enabled functions,
 * so the model is only asked for what will actually be applied. The same
 * definition produces a JSON schema for providers with structured output.
 */
import type { AppConfig, CustomFieldConfig } from '../config/schema.js';
import { estimateTokens, truncateToTokens } from '../ai/tokens.js';
import type { ChatMessage } from '../ai/types.js';

export interface PromptContext {
  /** Names of existing objects in Paperless (sorted by relevance, most used first). */
  tags: string[];
  correspondents: string[];
  documentTypes: string[];
  /** Custom fields that may be filled. */
  customFields: CustomFieldConfig[];
  /** Data fetched from the external API (already transformed). */
  externalData?: unknown;
}

export interface PromptOptions {
  /** Replaces the configured system prompt (webhook `prompt`, playground). */
  customPrompt?: string;
}

const MAX_LIST_TOKENS = 3000;
const MAX_EXTERNAL_TOKENS = 1000;
/** Up to this many allowed values are enforced through the JSON schema enum. */
const MAX_ENUM_VALUES = 400;

type Processing = AppConfig['processing'];

export function enabledFields(p: Processing) {
  return {
    title: p.functions.title,
    correspondent: p.functions.correspondent,
    tags: p.functions.tags || p.usePromptTags,
    documentType: p.functions.documentType,
    documentDate: p.functions.documentDate,
    customFields: p.functions.customFields && p.customFields.length > 0,
  };
}

/** Join names until the token budget is used up. */
function joinLimited(names: string[], maxTokens: number): string {
  const out: string[] = [];
  let used = 0;
  for (const n of names) {
    const t = estimateTokens(n) + 1;
    if (used + t > maxTokens) {
      out.push(`… (+${names.length - out.length} more)`);
      break;
    }
    out.push(n);
    used += t;
  }
  return out.join(', ');
}

function allowedTags(p: Processing, ctx: PromptContext): string[] | null {
  if (p.usePromptTags) return p.promptTags;
  if (p.restrict.tags) return ctx.tags;
  return null;
}

export function buildJsonSchema(p: Processing, ctx: PromptContext): Record<string, unknown> {
  const f = enabledFields(p);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const str = (description: string) => ({ type: 'string', description });

  if (f.title) {
    properties.title = str('Short, meaningful document title in the document language');
    required.push('title');
  }
  if (f.correspondent) {
    const allowed = p.restrict.correspondents && ctx.correspondents.length <= MAX_ENUM_VALUES ? ctx.correspondents : null;
    properties.correspondent = allowed?.length
      ? { type: 'string', enum: [...allowed, ''], description: 'Sender of the document, empty if unknown' }
      : str('Sender/institution in the shortest form, empty if unknown');
    required.push('correspondent');
  }
  if (f.tags) {
    const allowed = allowedTags(p, ctx);
    const items = allowed?.length && allowed.length <= MAX_ENUM_VALUES ? { type: 'string', enum: allowed } : { type: 'string' };
    properties.tags = { type: 'array', items, description: 'Thematic tags' };
    required.push('tags');
  }
  if (f.documentType) {
    const allowed = p.restrict.documentTypes && ctx.documentTypes.length <= MAX_ENUM_VALUES ? ctx.documentTypes : null;
    properties.document_type = allowed?.length
      ? { type: 'string', enum: [...allowed, ''], description: 'Type of the document' }
      : str('Type of the document, e.g. Invoice, Contract, Letter');
    required.push('document_type');
  }
  if (f.documentDate) {
    properties.document_date = str('Date of the document as YYYY-MM-DD, empty if none');
    required.push('document_date');
  }
  properties.language = str('Language code of the document, e.g. "de" or "en"');
  required.push('language');
  if (f.customFields) {
    properties.custom_fields = {
      type: 'array',
      description: 'Values for the custom fields; omit fields without information in the document',
      items: {
        type: 'object',
        properties: {
          field_name: { type: 'string', enum: p.customFields.map((c) => c.name) },
          value: { type: 'string' },
        },
        required: ['field_name', 'value'],
        additionalProperties: false,
      },
    };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function fieldHint(c: CustomFieldConfig): string {
  const type: Record<CustomFieldConfig['type'], string> = {
    string: 'text',
    integer: 'whole number',
    float: 'decimal number with "." as decimal separator',
    monetary: `amount as decimal number with "." as decimal separator, no currency symbol${c.currency ? ` (currency ${c.currency})` : ''}`,
    date: 'date as YYYY-MM-DD',
    boolean: '"true" or "false"',
    url: 'URL',
  };
  return `- "${c.name}": ${type[c.type]}${c.description ? ` – ${c.description}` : ''}`;
}

/** The output contract appended to every system prompt (replaces the old "mustHavePrompt"). */
export function buildOutputInstructions(p: Processing, ctx: PromptContext): string {
  const f = enabledFields(p);
  const example: Record<string, unknown> = {};
  if (f.title) example.title = '…';
  if (f.correspondent) example.correspondent = '…';
  if (f.tags) example.tags = ['…', '…'];
  if (f.documentType) example.document_type = '…';
  if (f.documentDate) example.document_date = 'YYYY-MM-DD';
  example.language = 'de/en/…';
  if (f.customFields) example.custom_fields = [{ field_name: p.customFields[0].name, value: '…' }];

  const lines = [
    'Return the result EXCLUSIVELY as one JSON object (no markdown, no explanations) with exactly this structure:',
    JSON.stringify(example, null, 2),
    'Rules:',
    '- Tags, title and document type MUST be written in the language of the document.',
    '- Use an empty string for values that cannot be determined. Never ask questions.',
  ];
  if (f.customFields) {
    lines.push('- custom_fields: only include fields whose value is present in the document. Available fields:');
    lines.push(...p.customFields.map(fieldHint));
  }
  const allowed = allowedTags(p, ctx);
  if (f.tags && allowed) lines.push(`- tags: ONLY use tags from this list: ${joinLimited(allowed, MAX_LIST_TOKENS)}`);
  if (f.correspondent && p.restrict.correspondents) {
    lines.push(`- correspondent: ONLY use one of: ${joinLimited(ctx.correspondents, MAX_LIST_TOKENS)} (empty string if none fits)`);
  }
  if (f.documentType && p.restrict.documentTypes) {
    lines.push(`- document_type: ONLY use one of: ${joinLimited(ctx.documentTypes, MAX_LIST_TOKENS / 2)} (empty string if none fits)`);
  }
  return lines.join('\n');
}

function promptTagsPrompt(tags: string[]): string {
  return `You are a document analysis AI. Analyze the document and associate the best fitting tags from the given list with it.
Also determine the correspondent (the sender, not the receiver) and a meaningful, short title.
Available tags: ${tags.join(', ')}
Only use tags from this list. Do not ask for additional information; use only the information in the document.`;
}

/** Legacy placeholders supported in user prompts. */
function replacePlaceholders(prompt: string, p: Processing, ctx: PromptContext): string {
  const customFieldList = p.customFields.map((c) => c.name).join(', ');
  return prompt
    .replace(/%RESTRICTED_TAGS%/g, joinLimited(allowedTags(p, ctx) ?? ctx.tags, MAX_LIST_TOKENS))
    .replace(/%RESTRICTED_CORRESPONDENTS%/g, joinLimited(ctx.correspondents, MAX_LIST_TOKENS))
    .replace(/%RESTRICTED_DOCUMENT_TYPES%/g, joinLimited(ctx.documentTypes, MAX_LIST_TOKENS / 2))
    .replace(/%CUSTOMFIELDS%/g, customFieldList);
}

export function buildSystemPrompt(p: Processing, ctx: PromptContext, opts: PromptOptions = {}): string {
  const parts: string[] = [];
  const base = opts.customPrompt?.trim() || (p.usePromptTags ? promptTagsPrompt(p.promptTags) : p.systemPrompt.trim());
  parts.push(replacePlaceholders(base, p, ctx));

  if (p.useExistingData) {
    const f = enabledFields(p);
    const existing: string[] = [];
    if (f.tags && !allowedTags(p, ctx)) existing.push(`Existing tags (prefer these): ${joinLimited(ctx.tags, MAX_LIST_TOKENS)}`);
    if (f.correspondent && !p.restrict.correspondents) {
      existing.push(`Existing correspondents (prefer these): ${joinLimited(ctx.correspondents, MAX_LIST_TOKENS)}`);
    }
    if (f.documentType && !p.restrict.documentTypes) {
      existing.push(`Existing document types (prefer these): ${joinLimited(ctx.documentTypes, MAX_LIST_TOKENS / 2)}`);
    }
    if (existing.length) parts.push(existing.join('\n\n'));
  }

  if (ctx.externalData !== undefined && ctx.externalData !== null && ctx.externalData !== '') {
    const raw = typeof ctx.externalData === 'string' ? ctx.externalData : JSON.stringify(ctx.externalData, null, 2);
    parts.push(`Additional context from external API:\n${truncateToTokens(raw, MAX_EXTERNAL_TOKENS).text}`);
  }
  parts.push(buildOutputInstructions(p, ctx));
  return parts.join('\n\n');
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  schema: Record<string, unknown>;
  truncated: boolean;
  promptTokens: number;
}

/**
 * Assemble the chat messages, truncating the document content so that
 * prompt + answer fit into the configured context window.
 */
export function buildAnalysisPrompt(
  cfg: AppConfig,
  content: string,
  ctx: PromptContext,
  opts: PromptOptions & { filename?: string | null } = {},
): BuiltPrompt {
  const system = buildSystemPrompt(cfg.processing, ctx, opts);
  const header = opts.filename ? `Original file name: ${opts.filename}\n\n` : '';
  const wrapperTokens = estimateTokens(`${header}Document content:\n"""\n\n"""`) + 16;
  const budget = cfg.ai.tokenLimit - cfg.ai.responseTokens - estimateTokens(system) - wrapperTokens;
  if (budget < 200) {
    throw new Error(
      `The prompt does not fit into the token limit (${cfg.ai.tokenLimit}). Increase the token limit or shorten the prompt / tag lists.`,
    );
  }
  // Keep a safety margin of 5% because token estimation is approximate.
  const { text, truncated } = truncateToTokens(content, Math.floor(budget * 0.95));
  const user = `${header}Document content:\n"""\n${text}\n"""`;
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    schema: buildJsonSchema(cfg.processing, ctx),
    truncated,
    promptTokens: estimateTokens(system) + estimateTokens(user),
  };
}
