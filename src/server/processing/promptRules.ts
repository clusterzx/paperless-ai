/**
 * Prompt rules: which prompt of the library and which processing settings a document is analysed
 * with. The first enabled rule whose conditions all match wins; without a match the system prompt
 * and the processing settings apply unchanged.
 */
import type { AppContext } from '../context.js';
import type { AppConfig, PromptRule } from '../config/schema.js';
import type { PromptRow } from '../db/promptsRepo.js';
import { normalizeName, type MetadataCache } from '../backend/metadata.js';
import type { ArchiveDocument } from '../backend/types.js';
import { ruleLabel, type MatchedPromptRule, type PromptRuleConditions, type PromptRuleConfig } from '../../shared/promptRules.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'prompt-rules' });

type Processing = AppConfig['processing'];

// The schema and the shared type describe the same rule.
const sameShape = (rule: PromptRule): PromptRuleConfig => rule;
void sameShape;

export interface AppliedPromptRule {
  index: number;
  rule: PromptRule;
  prompt: PromptRow;
  /** The processing settings for this document. */
  processing: Processing;
  /** Own model of the rule, null = the one of the AI settings. */
  model: string | null;
}

/** What is known about a document for the conditions (names normalised). */
export interface DocumentFacts {
  tags: Set<string>;
  documentType: string | null;
  correspondent: string | null;
  storagePath: string | null;
  /** User name and id of the owner. */
  owner: string[];
  /** Custom field name → value as text. */
  customFields: Map<string, string>;
}

/** The library prompt of a rule: by id, or by name (rules from the environment). */
export function rulePrompt(ctx: AppContext, rule: Pick<PromptRule, 'prompt'>): PromptRow | undefined {
  if (typeof rule.prompt === 'number') return ctx.repos.prompts.get(rule.prompt);
  const wanted = normalizeName(rule.prompt);
  return ctx.repos.prompts.list().find((p) => normalizeName(p.name) === wanted);
}

/** All conditions that are set must match; a rule without conditions matches every document. */
export function matchesConditions(c: PromptRuleConditions, f: DocumentFacts): boolean {
  const has = (list: string[], value: string | null) => !list.length || (value !== null && list.some((n) => normalizeName(n) === value));
  if (c.tagsAny.length && !c.tagsAny.some((t) => f.tags.has(normalizeName(t)))) return false;
  if (c.tagsAll.length && !c.tagsAll.every((t) => f.tags.has(normalizeName(t)))) return false;
  if (!has(c.documentTypes, f.documentType) || !has(c.correspondents, f.correspondent) || !has(c.storagePaths, f.storagePath)) return false;
  if (c.owners.length && !c.owners.some((o) => f.owner.includes(normalizeName(o)))) return false;
  if (c.customField) {
    const value = f.customFields.get(normalizeName(c.customField.name));
    if (value === undefined || value === '') return false;
    if (c.customField.value && normalizeName(value) !== normalizeName(c.customField.value)) return false;
  }
  return true;
}

/** The processing settings for documents of a rule: the settings with the overrides of the rule. */
export function ruleProcessing(base: Processing, rule: PromptRule, promptText: string): Processing {
  const o = rule.overrides;
  const defined = <T extends object>(obj: T) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
  const wanted = o.customFields ? new Set(o.customFields.map(normalizeName)) : null;
  const p: Processing = {
    ...base,
    systemPrompt: promptText,
    functions: { ...base.functions, ...defined(o.functions) } as Processing['functions'],
    restrict: { ...base.restrict, ...defined(o.restrict) } as Processing['restrict'],
    customFields: wanted ? base.customFields.filter((c) => wanted.has(normalizeName(c.name))) : base.customFields,
  };
  if (o.allowedTags) {
    p.usePromptTags = true;
    p.promptTags = o.allowedTags;
  }
  // "Tags: no" wins over a tag list (the fixed tag list of the settings would switch tags on again).
  if (o.functions.tags === false) p.usePromptTags = false;
  if (o.allowedDocumentTypes) p.allowedDocumentTypes = o.allowedDocumentTypes;
  return p;
}

async function documentFacts(meta: MetadataCache, doc: ArchiveDocument, withExtras: boolean): Promise<DocumentFacts> {
  await meta.snapshot();
  const extras = withExtras ? await meta.extras() : null;
  const name = (n: string | null | undefined) => (n ? normalizeName(n) : null);
  const customFields = new Map<string, string>();
  for (const { field, value } of doc.custom_fields ?? []) {
    const def = meta.customField(field);
    if (!def || value === null || value === undefined) continue;
    // Select fields store the id (newer Paperless) or the index of the option.
    const options = def.extra_data?.select_options ?? [];
    let text = String(value);
    if (def.data_type === 'select') {
      const option = options.find((o, i) => (typeof o === 'string' ? String(i) === text : o.id === text));
      if (option) text = typeof option === 'string' ? option : option.label;
    }
    customFields.set(normalizeName(def.name), text);
  }
  const owner = doc.owner == null ? [] : [String(doc.owner), name(extras?.users.find((u) => u.id === doc.owner)?.username)].filter((v): v is string => Boolean(v));
  return {
    tags: new Set((doc.tags ?? []).map((id) => name(meta.tagName(id))).filter((t): t is string => Boolean(t))),
    documentType: name(meta.documentTypeName(doc.document_type)),
    correspondent: name(meta.correspondentName(doc.correspondent)),
    storagePath: name(extras?.storagePaths.find((s) => s.id === doc.storage_path)?.name),
    owner,
    customFields,
  };
}

/** The first rule that applies to the document, with its prompt and processing settings. */
export async function matchPromptRule(ctx: AppContext, doc: ArchiveDocument): Promise<AppliedPromptRule | null> {
  const rules = ctx.cfg.processing.promptRules;
  if (!rules.some((r) => r.enabled)) return null;
  const withExtras = rules.some((r) => r.enabled && (r.match.storagePaths.length > 0 || r.match.owners.length > 0));
  const facts = await documentFacts(ctx.metadata(doc.library_id ?? null), doc, withExtras);
  for (const [index, rule] of rules.entries()) {
    if (!rule.enabled || !matchesConditions(rule.match, facts)) continue;
    const prompt = rulePrompt(ctx, rule);
    if (!prompt) {
      log.warn(`Prompt rule "${ruleLabel(rule, index)}" refers to a prompt that is not in the prompt library (${rule.prompt}) – skipped`);
      continue;
    }
    return { index, rule, prompt, processing: ruleProcessing(ctx.cfg.processing, rule, prompt.prompt), model: rule.overrides.model || null };
  }
  return null;
}

export function describeMatch(m: AppliedPromptRule): MatchedPromptRule {
  return { index: m.index, name: ruleLabel(m.rule, m.index), promptId: m.prompt.id, promptName: m.prompt.name, model: m.model };
}
