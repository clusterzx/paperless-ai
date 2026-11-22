/**
 * The `analysis.before` trigger (docs/standalone/workflows.md §7.2): evaluated synchronously in the
 * processing job, exactly where the prompt rules were. The result is a copy of the processing
 * settings (prompt, functions, restrictions, allowed lists, model) or "skip". Prompt building,
 * planning the update and the calendar use that copy, so nothing else needs to know.
 */
import type { AppContext } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import type { ArchiveDocument } from '../backend/types.js';
import type { PromptRow } from '../db/promptsRepo.js';
import { processingWith, rulePrompt } from '../processing/promptRules.js';
import { evaluateGroup, type RunSubject } from './evaluate.js';
import { lockedRuleWorkflows } from './promptRules.js';
import type { MatchedPromptRule, PromptRuleOverrides } from '../../shared/promptRules.js';
import type { RunStep, Workflow } from '../../shared/workflows.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'workflows' });

type Processing = AppConfig['processing'];

export interface AnalysisPlan {
  /** The workflow whose "analyze" action chose the prompt (logs, history, the review page). */
  source: { workflowId: number; name: string; index: number } | null;
  prompt: PromptRow | null;
  processing: Processing;
  /** Own model, null = the one of the AI settings. */
  model: string | null;
  /** Reason when a workflow skips the analysis. */
  skip: string | null;
}

/** The analysis with an explicit prompt and overrides (an "analyze" action of another trigger). */
export function planFromAction(ctx: AppContext, prompt: PromptRow | null, overrides: PromptRuleOverrides, workflow: string): AnalysisPlan {
  return {
    source: { workflowId: 0, name: workflow, index: -1 },
    prompt,
    processing: processingWith(ctx.cfg.processing, overrides, prompt?.prompt ?? null),
    model: overrides.model || null,
    skip: null,
  };
}

/**
 * Evaluate the `analysis.before` workflows of the document's library (and the global ones) in
 * order. Returns null when none applies – the processing settings are used unchanged.
 */
export async function planAnalysis(ctx: AppContext, doc: ArchiveDocument, opts: { record: boolean; intake?: RunSubject['intake'] }): Promise<AnalysisPlan | null> {
  const stored = ctx.repos.workflows.list({ trigger: 'analysis.before', enabledOnly: true, libraryIds: doc.library_id != null ? [doc.library_id] : null });
  const workflows: Workflow[] = [...lockedRuleWorkflows(ctx).filter((w) => w.enabled), ...stored];
  if (!workflows.length) return null;
  const subject: RunSubject = { doc, meta: ctx.metadata(doc.library_id ?? null), intake: opts.intake ?? {} };
  let plan: AnalysisPlan | null = null;
  for (const [index, wf] of workflows.entries()) {
    const steps: RunStep[] = [];
    const matched = await evaluateGroup(wf.conditions, { ctx, subject, steps, tokens: { used: 0 } });
    if (!matched) continue;
    let applied = false;
    let error: string | null = null;
    for (const action of wf.actions) {
      const step: RunStep = { idx: steps.length, kind: 'action', name: action.type === 'analyze' ? 'Analyse with' : 'Skip the AI analysis', status: 'done', details: {}, durationMs: 0 };
      steps.push(step);
      if (action.type === 'skip_analysis') {
        plan = { ...(plan ?? base(ctx)), skip: `Not analysed (workflow “${wf.name}”)` };
        applied = true;
      } else if (action.type === 'analyze') {
        const prompt = action.prompt === null ? null : (rulePrompt(ctx, { prompt: action.prompt }) ?? undefined);
        if (prompt === undefined) {
          // Like a prompt rule whose prompt is gone: skipped, the next one may apply.
          error = `The prompt ${typeof action.prompt === 'number' ? `#${action.prompt}` : `“${action.prompt}”`} is not in the prompt library`;
          step.status = 'failed';
          step.details = { error };
          log.warn(`Workflow "${wf.name}": ${error} – skipped`);
          break;
        }
        const cur: AnalysisPlan = plan ?? base(ctx);
        plan = {
          source: { workflowId: wf.id, name: wf.name, index },
          prompt: prompt ?? cur.prompt,
          processing: processingWith(cur.processing, action.overrides, prompt?.prompt ?? null),
          model: action.overrides.model || cur.model,
          skip: cur.skip,
        };
        step.details = { prompt: prompt?.name ?? 'system prompt', model: action.overrides.model || null };
        applied = true;
      }
    }
    if (opts.record && wf.id > 0) {
      const runId = ctx.repos.workflows.enqueue({ workflowId: wf.id, revision: wf.revision, documentId: doc.id, trigger: 'analysis.before', status: error ? 'failed' : 'succeeded', error });
      if (runId) for (const s of steps) ctx.repos.workflows.addStep(runId, s);
    }
    if (error) continue;
    if (applied && (wf.stopAfterMatch || plan?.skip)) break;
  }
  return plan;
}

function base(ctx: AppContext): AnalysisPlan {
  return { source: null, prompt: null, processing: ctx.cfg.processing, model: null, skip: null };
}

/** For the review page and the prompt rules view: the rule (workflow) a document would be analysed with. */
export function describePlan(plan: AnalysisPlan | null): MatchedPromptRule | null {
  if (!plan?.source || !plan.prompt) return null;
  return { index: plan.source.index, name: plan.source.name, promptId: plan.prompt.id, promptName: plan.prompt.name, model: plan.model };
}
