import type { AnalysisResult } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import { extractJsonObject, JsonExtractionError } from '../ai/json.js';
import { normalizeContent } from '../ai/tokens.js';
import { AiError, type ChatMessage, type CompletionResult } from '../ai/types.js';
import { logger } from '../logger.js';
import { UserError } from '../util/errors.js';
import { fetchExternalData } from './externalApi.js';
import { buildAnalysisPrompt, type BuiltPrompt, type PromptContext } from './prompt.js';
import { normalizeSuggestion } from './suggestion.js';

const log = logger.child({ module: 'analyzer' });

export interface AnalyzeOptions {
  feature: 'process' | 'manual' | 'playground';
  documentId?: number | null;
  customPrompt?: string;
  filename?: string | null;
  signal?: AbortSignal;
  /** Processing settings for this analysis only (testing the prompt wizard before saving). */
  processing?: AppConfig['processing'];
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
    selectOptions: Object.fromEntries(
      meta.customFields
        .filter((f) => f.data_type === 'select')
        .map((f) => [f.name, (f.extra_data?.select_options ?? []).map((o) => (typeof o === 'string' ? o : o.label))]),
    ),
    externalData: await fetchExternalData(ctx.cfg.externalApi),
  };
}

/** Analyse document text with the configured AI provider. Does not modify anything. */
export async function analyzeContent(ctx: AppContext, rawContent: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  const content = normalizeContent(rawContent);
  if (content.length < 10) throw new UserError('The document has no (or almost no) text content. Is OCR finished?');
  const cfg = opts.processing ? { ...ctx.cfg, processing: opts.processing } : ctx.cfg;
  const llm = ctx.llm();
  const promptCtx = await buildPromptContext(ctx);
  const promptOpts = { customPrompt: opts.customPrompt, filename: opts.filename };
  let built = buildAnalysisPrompt(cfg, content, promptCtx, promptOpts);
  let maxTokens = cfg.ai.responseTokens;
  const request = (messages: ChatMessage[]) =>
    llm.complete(messages, {
      temperature: cfg.ai.temperature,
      maxTokens,
      jsonSchema: { name: 'document_analysis', schema: built.schema },
      signal: opts.signal,
    });

  let result: CompletionResult = await request(built.messages);
  let total = { ...result.usage };
  const add = (r: CompletionResult) => {
    total = {
      promptTokens: total.promptTokens + r.usage.promptTokens,
      completionTokens: total.completionTokens + r.usage.completionTokens,
      totalTokens: total.totalTokens + r.usage.totalTokens,
    };
  };

  // A cut-off answer must never be applied: the JSON repair would turn it into a valid but incomplete
  // suggestion (tags or custom fields missing, a title cut in half). Ask once more with a larger answer
  // budget – the document content is shortened as needed so that the request still fits the context.
  if (result.truncated) {
    const larger = Math.min(200_000, Math.max(maxTokens * 2, maxTokens + 1000));
    const retry = tryBuild(() => buildAnalysisPrompt({ ...cfg, ai: { ...cfg.ai, responseTokens: larger } }, content, promptCtx, promptOpts));
    if (!retry) throw cutOff(maxTokens);
    log.warn(`The answer for document ${opts.documentId ?? '?'} was cut off at ${maxTokens} tokens – retrying once with ${larger}`);
    built = retry;
    maxTokens = larger;
    result = await request(built.messages);
    add(result);
    if (result.truncated) throw cutOff(maxTokens);
  }

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
    add(result);
    if (result.truncated) throw cutOff(maxTokens);
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

function tryBuild(build: () => BuiltPrompt): BuiltPrompt | null {
  try {
    return build();
  } catch {
    // A larger answer budget leaves no room for the prompt in the context window.
    return null;
  }
}

/** The answer hit the output limit – nothing of it is applied. */
function cutOff(maxTokens: number): AiError {
  return new AiError(
    `The answer of the model was cut off at the output limit (${maxTokens} tokens) – nothing was applied. ` +
      'Increase "Answer tokens" in Settings → AI provider → Advanced, or shorten the prompt (fewer fields or custom fields to fill).',
  );
}
