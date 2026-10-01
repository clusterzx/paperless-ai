import type { AnalysisResult } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { extractJsonObject, JsonExtractionError } from '../ai/json.js';
import { normalizeContent } from '../ai/tokens.js';
import type { ChatMessage, CompletionResult } from '../ai/types.js';
import { logger } from '../logger.js';
import { UserError } from '../util/errors.js';
import { fetchExternalData } from './externalApi.js';
import { buildAnalysisPrompt, type PromptContext } from './prompt.js';
import { normalizeSuggestion } from './suggestion.js';

const log = logger.child({ module: 'analyzer' });

export interface AnalyzeOptions {
  feature: 'process' | 'manual' | 'playground';
  documentId?: number | null;
  customPrompt?: string;
  filename?: string | null;
  signal?: AbortSignal;
}

export async function buildPromptContext(ctx: AppContext): Promise<PromptContext> {
  const meta = await ctx.metadata().snapshot();
  const byUsage = <T extends { name: string; document_count?: number }>(items: T[]) =>
    [...items].sort((a, b) => (b.document_count ?? 0) - (a.document_count ?? 0) || a.name.localeCompare(b.name)).map((i) => i.name);
  const processedTag = ctx.cfg.processing.processedTagName.toLowerCase();
  const triggerTags = new Set(ctx.cfg.processing.tags.map((t) => t.toLowerCase()));
  return {
    // Internal marker tags must never be suggested by the AI.
    tags: byUsage(meta.tags).filter((t) => t.toLowerCase() !== processedTag && !triggerTags.has(t.toLowerCase())),
    correspondents: byUsage(meta.correspondents),
    documentTypes: byUsage(meta.documentTypes),
    customFields: ctx.cfg.processing.customFields,
    externalData: await fetchExternalData(ctx.cfg.externalApi),
  };
}

/** Analyse document text with the configured AI provider. Does not modify anything. */
export async function analyzeContent(ctx: AppContext, rawContent: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  const content = normalizeContent(rawContent);
  if (content.length < 10) throw new UserError('The document has no (or almost no) text content. Is OCR finished?');
  const cfg = ctx.cfg;
  const llm = ctx.llm();
  const promptCtx = await buildPromptContext(ctx);
  const built = buildAnalysisPrompt(cfg, content, promptCtx, { customPrompt: opts.customPrompt, filename: opts.filename });
  const request = (messages: ChatMessage[]) =>
    llm.complete(messages, {
      temperature: cfg.ai.temperature,
      maxTokens: cfg.ai.responseTokens,
      jsonSchema: { name: 'document_analysis', schema: built.schema },
      signal: opts.signal,
    });

  let result: CompletionResult = await request(built.messages);
  let total = { ...result.usage };
  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(result.text);
  } catch (err) {
    if (!(err instanceof JsonExtractionError)) throw err;
    log.warn(`Model returned no valid JSON for document ${opts.documentId ?? '?'} – retrying once`);
    result = await request([
      ...built.messages,
      { role: 'assistant', content: result.text.slice(0, 4000) },
      { role: 'user', content: 'Your answer was not valid JSON. Reply again with ONLY the JSON object, nothing else.' },
    ]);
    total = {
      promptTokens: total.promptTokens + result.usage.promptTokens,
      completionTokens: total.completionTokens + result.usage.completionTokens,
      totalTokens: total.totalTokens + result.usage.totalTokens,
    };
    parsed = extractJsonObject(result.text);
  }

  // Providers that do not report usage: fall back to the estimate so statistics stay meaningful.
  if (!total.totalTokens) {
    const completion = Math.ceil(result.text.length / 3.6);
    total = { promptTokens: built.promptTokens, completionTokens: completion, totalTokens: built.promptTokens + completion };
  }
  const analysis: AnalysisResult = {
    suggestion: normalizeSuggestion(parsed),
    usage: total,
    model: result.model,
    provider: llm.provider,
    durationMs: result.durationMs,
    truncated: built.truncated,
  };
  ctx.recordUsage(opts.feature, { usage: total, model: result.model, durationMs: result.durationMs }, opts.documentId);
  return analysis;
}
