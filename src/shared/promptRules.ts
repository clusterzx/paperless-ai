/**
 * Prompt rules: documents matching the conditions of a rule are analysed with a prompt from the
 * prompt library and, optionally, with their own processing settings. The first matching rule wins;
 * without a match the system prompt and the processing settings are used.
 */

export const RULE_FUNCTIONS = ['title', 'correspondent', 'documentType', 'tags', 'documentDate', 'customFields', 'events'] as const;
export type RuleFunction = (typeof RULE_FUNCTIONS)[number];
export const RULE_RESTRICTIONS = ['tags', 'correspondents', 'documentTypes'] as const;
export type RuleRestriction = (typeof RULE_RESTRICTIONS)[number];

export interface PromptRuleConditions {
  /** At least one of these tags. */
  tagsAny: string[];
  /** All of these tags. */
  tagsAll: string[];
  documentTypes: string[];
  correspondents: string[];
  storagePaths: string[];
  /** Paperless user names (or user ids) of the owner. */
  owners: string[];
  /** A custom field is set – to `value`, if given. */
  customField: { name: string; value: string } | null;
}

export interface PromptRuleOverrides {
  /** Which fields the AI fills; a missing entry keeps the processing setting. */
  functions: Partial<Record<RuleFunction, boolean>>;
  /** Fill only these of the configured custom fields; null = all. */
  customFields: string[] | null;
  /** Only existing tags / correspondents / document types; a missing entry keeps the processing setting. */
  restrict: Partial<Record<RuleRestriction, boolean>>;
  /** The AI may only use these tags / document types (created when missing); null = no list. */
  allowedTags: string[] | null;
  allowedDocumentTypes: string[] | null;
  /** Model of the configured AI provider; empty = the one in the AI settings. */
  model: string;
}

export interface PromptRuleConfig {
  name: string;
  enabled: boolean;
  /** Library prompt: its id, or its name (rules from the environment). */
  prompt: number | string;
  match: PromptRuleConditions;
  overrides: PromptRuleOverrides;
}

/** GET /api/prompt-rules */
export interface PromptRulesInfo {
  rules: (PromptRuleConfig & { promptId: number | null; promptName: string | null; problem: string | null })[];
  /** Set by this environment variable – not editable in the web interface. */
  locked: string | null;
  storagePaths: string[];
  /** Paperless users (empty without the permission to view users). */
  owners: string[];
  /** The custom fields of the processing settings. */
  customFields: string[];
  /** The model of the AI settings (default of a rule). */
  model: string;
  /** More workflows run before the analysis that do not fit the rule shape (edited under Workflows). */
  otherWorkflows?: number;
}

/** The rule a document is (or would be) analysed with. */
export interface MatchedPromptRule {
  index: number;
  name: string;
  promptId: number;
  promptName: string;
  /** Own model of the rule, null = the one of the AI settings. */
  model: string | null;
}

export function emptyConditions(): PromptRuleConditions {
  return { tagsAny: [], tagsAll: [], documentTypes: [], correspondents: [], storagePaths: [], owners: [], customField: null };
}

export function emptyOverrides(): PromptRuleOverrides {
  return { functions: {}, customFields: null, restrict: {}, allowedTags: null, allowedDocumentTypes: null, model: '' };
}

export function ruleLabel(rule: Pick<PromptRuleConfig, 'name'>, index: number): string {
  return rule.name.trim() || `Rule ${index + 1}`;
}

/** No condition set: the rule applies to every document. */
export function matchesEverything(c: PromptRuleConditions): boolean {
  return !c.tagsAny.length && !c.tagsAll.length && !c.documentTypes.length && !c.correspondents.length && !c.storagePaths.length && !c.owners.length && !c.customField;
}
