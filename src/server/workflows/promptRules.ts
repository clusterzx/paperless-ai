/**
 * Prompt rules are workflows (docs/standalone/workflows.md §8): a rule is a global workflow with
 * the trigger `analysis.before`, conditions that must all match, one `analyze` action and
 * "stop after a match". Rules in the configuration (older versions, `ctx.config.update`) are moved
 * into workflows; rules from the environment variable stay read-only and are evaluated as virtual
 * workflows. The prompt rules page is a simplified view on the workflows that fit this shape.
 */
import type { AppContext } from '../context.js';
import type { PromptRule } from '../config/schema.js';
import { promptRuleSchema } from '../config/schema.js';
import { ruleLabel, type PromptRuleConfig } from '../../shared/promptRules.js';
import { isGroup, type Condition, type Workflow, type WorkflowDefinition } from '../../shared/workflows.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'workflows' });

export function ruleToDefinition(rule: PromptRule, index: number): WorkflowDefinition {
  const m = rule.match;
  const items: Condition[] = [];
  if (m.tagsAny.length) items.push({ type: 'tags', mode: 'any', names: m.tagsAny });
  if (m.tagsAll.length) items.push({ type: 'tags', mode: 'all', names: m.tagsAll });
  if (m.documentTypes.length) items.push({ type: 'document_type', names: m.documentTypes });
  if (m.correspondents.length) items.push({ type: 'correspondent', names: m.correspondents });
  if (m.storagePaths.length) items.push({ type: 'storage_path', names: m.storagePaths });
  if (m.owners.length) items.push({ type: 'owner', names: m.owners });
  if (m.customField) items.push({ type: 'custom_field', name: m.customField.name, op: m.customField.value ? 'equals' : 'set', value: m.customField.value || undefined });
  return {
    name: ruleLabel(rule, index),
    enabled: rule.enabled,
    libraryId: null,
    trigger: { type: 'analysis.before' },
    conditions: { op: 'all', items },
    actions: [{ type: 'analyze', prompt: rule.prompt, overrides: rule.overrides }],
    stopAfterMatch: true,
    allowedLibraries: [],
  };
}

/** The rule a workflow stands for – null when it does not fit the prompt rule shape. */
export function definitionToRule(w: Pick<Workflow, 'name' | 'enabled' | 'libraryId' | 'trigger' | 'conditions' | 'actions' | 'stopAfterMatch'>): PromptRuleConfig | null {
  if (w.libraryId !== null || w.trigger.type !== 'analysis.before' || !w.stopAfterMatch || w.conditions.op !== 'all') return null;
  if (w.actions.length !== 1 || w.actions[0].type !== 'analyze' || w.actions[0].prompt === null) return null;
  const match = promptRuleSchema.shape.match.parse({});
  const seen = new Set<string>();
  for (const c of w.conditions.items) {
    if (isGroup(c)) return null;
    const key = c.type === 'tags' ? `tags:${c.mode}` : c.type;
    if (seen.has(key)) return null;
    seen.add(key);
    if (c.type === 'tags' && c.mode === 'any') match.tagsAny = c.names;
    else if (c.type === 'tags' && c.mode === 'all') match.tagsAll = c.names;
    else if (c.type === 'document_type') match.documentTypes = c.names;
    else if (c.type === 'correspondent') match.correspondents = c.names;
    else if (c.type === 'storage_path') match.storagePaths = c.names;
    else if (c.type === 'owner') match.owners = c.names;
    else if (c.type === 'custom_field' && (c.op === 'set' || c.op === 'equals')) match.customField = { name: c.name, value: c.op === 'equals' ? (c.value ?? '') : '' };
    else return null;
  }
  return { name: w.name, enabled: w.enabled, prompt: w.actions[0].prompt, match, overrides: w.actions[0].overrides };
}

/** Stored workflows shown as prompt rules, in order. */
export function ruleWorkflows(ctx: AppContext): { workflow: Workflow; rule: PromptRuleConfig }[] {
  return ctx.repos.workflows
    .list({ trigger: 'analysis.before' })
    .map((workflow) => ({ workflow, rule: definitionToRule(workflow) }))
    .filter((x): x is { workflow: Workflow; rule: PromptRuleConfig } => x.rule !== null);
}

/** Rules from the environment variable as read-only workflows (not stored; ids below zero). */
export function lockedRuleWorkflows(ctx: AppContext): Workflow[] {
  if (!ctx.config.lockedPaths['processing.promptRules']) return [];
  const now = Date.now();
  return ctx.cfg.processing.promptRules.map((rule, i) => ({
    ...ruleToDefinition(rule, i),
    id: -(i + 1),
    position: i - 10_000,
    revision: 1,
    suspendedReason: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    locked: true,
  }));
}

/** Replace the workflows of the prompt rules view by these rules (in this order, before the other workflows). */
export function replaceRuleWorkflows(ctx: AppContext, rules: PromptRule[], userId: number | null): void {
  const repo = ctx.repos.workflows;
  ctx.db.transaction(() => {
    for (const { workflow } of ruleWorkflows(ctx)) repo.delete(workflow.id);
    const ids = rules.map((rule, i) => repo.create(ruleToDefinition(rule, i), userId));
    const others = repo.list().map((w) => w.id).filter((id) => !ids.includes(id));
    repo.reorder([...ids, ...others]);
  })();
}

/**
 * Rules in the configuration become workflows (once for older installations, and whenever
 * something writes rules into the configuration). Rules from the environment stay where they are.
 */
export function moveConfigRulesToWorkflows(ctx: AppContext): void {
  if (ctx.config.lockedPaths['processing.promptRules']) return;
  const rules = ctx.cfg.processing.promptRules;
  if (!rules.length) return;
  replaceRuleWorkflows(ctx, rules, null);
  log.info(`${rules.length} prompt rule(s) are workflows now (trigger "before the analysis")`);
  ctx.config.update({ processing: { promptRules: [] } });
}
