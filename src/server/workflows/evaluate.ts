/**
 * Evaluation of workflow conditions against a document (docs/standalone/workflows.md §4). Cheap
 * conditions first; AI questions last and only when everything else matched. Every evaluated
 * condition becomes a run step with the compared values.
 */
import type { AppContext } from '../context.js';
import type { ArchiveDocument } from '../backend/types.js';
import { normalizeName, type MetadataCache } from '../backend/metadata.js';
import { documentFacts, type DocumentFacts } from '../processing/promptRules.js';
import { extractJsonObject } from '../ai/json.js';
import { contextBudget } from '../ai/factory.js';
import { truncateToTokens } from '../ai/tokens.js';
import { isGroup, type Condition, type ConditionGroup, type RunStep } from '../../shared/workflows.js';
import { globMatch, regexTest } from '../util/patterns.js';

/** What a run knows about its document. */
export interface RunSubject {
  doc: ArchiveDocument;
  meta: MetadataCache;
  /** Intake details (document.added): channel, mail sender / subject, folder, file name. */
  intake: { channel?: string; mailFrom?: string; mailSubject?: string; folder?: string; filename?: string };
}

export interface EvalEnv {
  ctx: AppContext;
  subject: RunSubject;
  /** Steps of the run (appended). */
  steps: RunStep[];
  /** Tokens used by AI questions (for the dry run). */
  tokens: { used: number };
  signal?: AbortSignal;
}

let factsCache = new WeakMap<RunSubject, Promise<DocumentFacts>>();

function facts(env: EvalEnv, withExtras: boolean): Promise<DocumentFacts> {
  const key = env.subject;
  let f = factsCache.get(key);
  if (!f || withExtras) {
    f = documentFacts(env.subject.meta, env.subject.doc, withExtras);
    factsCache.set(key, f);
  }
  return f;
}

/** For tests: forget cached facts. */
export function resetFactsCache(): void {
  factsCache = new WeakMap();
}

/** Text of the document the conditions and AI questions see (local OCR text wins, like the analysis). */
export function documentText(ctx: AppContext, doc: ArchiveDocument): string {
  return ctx.repos.ocr.localText(doc.id, doc.modified ?? null) ?? doc.content ?? '';
}

function cost(c: Condition | ConditionGroup): number {
  if (isGroup(c)) return Math.max(0, ...c.items.map(cost)) + 0.5;
  if (c.type === 'ai_question') return 100;
  if (c.type === 'text') return 3;
  if (c.type === 'storage_path' || c.type === 'owner') return 2;
  return 1;
}

const list = (v: string[]) => v.join(', ');

export function conditionLabel(c: Condition): string {
  switch (c.type) {
    case 'tags':
      return `Tags ${c.mode === 'any' ? 'any of' : c.mode === 'all' ? 'all of' : 'none of'} ${list(c.names)}`;
    case 'correspondent':
      return `Correspondent is ${list(c.names)}`;
    case 'document_type':
      return `Document type is ${list(c.names)}`;
    case 'storage_path':
      return `Storage path is ${list(c.names)}`;
    case 'owner':
      return `Owner is ${list(c.names)}`;
    case 'custom_field':
      return c.op === 'set' ? `Custom field “${c.name}” is set` : `Custom field “${c.name}” ${c.op === 'equals' ? '=' : c.op === 'gte' ? '≥' : '≤'} ${c.value ?? ''}`;
    case 'library':
      return `Library is one of ${c.ids.map((i) => `#${i}`).join(', ')}`;
    case 'channel':
      return `Arrived by ${list(c.channels)}`;
    case 'mail_from':
      return `Mail sender contains “${c.contains}”`;
    case 'mail_subject':
      return `Mail subject contains “${c.contains}”`;
    case 'folder_path':
      return `Folder contains “${c.contains}”`;
    case 'filename':
      return `File name matches ${c.pattern}`;
    case 'mime_type':
      return `File type is ${list(c.types)}`;
    case 'page_count':
      return `Pages ${c.min ?? 0}–${c.max ?? '∞'}`;
    case 'text':
      return c.regex ? `Text matches /${c.regex}/` : `Text contains “${c.contains ?? ''}”`;
    case 'created':
      return `Date ${c.from ?? '…'} – ${c.to ?? '…'}`;
    case 'added_within':
      return `Added within ${c.days} day(s)`;
    case 'processed':
      return c.value ? 'Analysed by the AI' : 'Not analysed by the AI yet';
    case 'analysis_failed':
      return c.value ? 'The last analysis failed' : 'The last analysis did not fail';
    case 'ai_question':
      return `AI: ${c.question} (expected: ${c.expect ? 'yes' : 'no'})`;
  }
}

function numberOf(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/^[A-Z]{3}/, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Evaluate one condition. Returns [matched, details]. */
async function evaluateOne(c: Condition, env: EvalEnv): Promise<[boolean, Record<string, unknown>]> {
  const { doc, intake } = env.subject;
  const has = (values: string[], actual: string | null) => !values.length || (actual !== null && values.some((n) => normalizeName(n) === actual));
  const contains = (actual: string | undefined, needle: string) => Boolean(actual) && actual!.toLowerCase().includes(needle.toLowerCase());
  switch (c.type) {
    case 'tags': {
      const f = await facts(env, false);
      const wanted = c.names.map(normalizeName);
      const ok = c.mode === 'any' ? wanted.some((t) => f.tags.has(t)) : c.mode === 'all' ? wanted.every((t) => f.tags.has(t)) : !wanted.some((t) => f.tags.has(t));
      return [ok, { tags: [...f.tags] }];
    }
    case 'correspondent': {
      const f = await facts(env, false);
      return [has(c.names, f.correspondent), { correspondent: f.correspondent }];
    }
    case 'document_type': {
      const f = await facts(env, false);
      return [has(c.names, f.documentType), { documentType: f.documentType }];
    }
    case 'storage_path': {
      const f = await facts(env, true);
      return [has(c.names, f.storagePath), { storagePath: f.storagePath }];
    }
    case 'owner': {
      const f = await facts(env, true);
      return [c.names.some((o) => f.owner.includes(normalizeName(o))), { owner: f.owner }];
    }
    case 'custom_field': {
      const f = await facts(env, false);
      const value = f.customFields.get(normalizeName(c.name));
      if (value === undefined || value === '') return [false, { value: null }];
      if (c.op === 'set') return [true, { value }];
      if (c.op === 'equals') return [normalizeName(value) === normalizeName(c.value ?? ''), { value }];
      const a = numberOf(value);
      const b = numberOf(c.value);
      // Dates (YYYY-MM-DD) compare as text, numbers as numbers.
      const cmp = a !== null && b !== null ? a - b : value.localeCompare(c.value ?? '');
      return [c.op === 'gte' ? cmp >= 0 : cmp <= 0, { value }];
    }
    case 'library':
      return [doc.library_id != null && c.ids.includes(doc.library_id), { library: doc.library_id ?? null }];
    case 'channel': {
      const channel = intake.channel ?? null;
      return [channel !== null && (c.channels as string[]).includes(channel), { channel }];
    }
    case 'mail_from':
      return [contains(intake.mailFrom, c.contains), { mailFrom: intake.mailFrom ?? null }];
    case 'mail_subject':
      return [contains(intake.mailSubject, c.contains), { mailSubject: intake.mailSubject ?? null }];
    case 'folder_path':
      return [contains(intake.folder, c.contains), { folder: intake.folder ?? null }];
    case 'filename': {
      const name = intake.filename ?? doc.original_file_name ?? '';
      return [globMatch(c.pattern, name), { filename: name }];
    }
    case 'mime_type': {
      const mime = doc.mime_type ?? null;
      return [mime !== null && c.types.some((t) => (t.endsWith('/*') ? mime.startsWith(t.slice(0, -1)) : mime === t)), { mimeType: mime }];
    }
    case 'page_count': {
      const pages = doc.page_count ?? null;
      return [pages !== null && pages >= (c.min ?? 0) && pages <= (c.max ?? Number.MAX_SAFE_INTEGER), { pages }];
    }
    case 'text': {
      const text = documentText(env.ctx, doc);
      let ok = true;
      if (c.contains) ok = text.toLowerCase().includes(c.contains.toLowerCase());
      if (ok && c.regex) ok = regexTest(new RegExp(c.regex, 'iu'), text);
      return [ok, { length: text.length }];
    }
    case 'created': {
      const created = (doc.created_date ?? doc.created ?? '').slice(0, 10) || null;
      return [created !== null && (!c.from || created >= c.from) && (!c.to || created <= c.to), { created }];
    }
    case 'added_within': {
      const added = doc.added ? Date.parse(doc.added) : NaN;
      return [Number.isFinite(added) && Date.now() - added <= c.days * 86_400_000, { added: doc.added ?? null }];
    }
    case 'processed': {
      const state = env.ctx.repos.documents.get(doc.id);
      return [(state?.status === 'processed') === c.value, { status: state?.status ?? null }];
    }
    case 'analysis_failed': {
      const state = env.ctx.repos.documents.get(doc.id);
      return [(state?.status === 'failed') === c.value, { status: state?.status ?? null, reason: state?.reason ?? null }];
    }
    case 'ai_question': {
      const answer = await askAi(env, c.question);
      return [answer.answer === c.expect, { answer: answer.answer, reason: answer.reason, cached: answer.cached }];
    }
  }
}

/** Evaluate a group (cheapest first, short-circuit). */
export async function evaluateGroup(group: ConditionGroup, env: EvalEnv): Promise<boolean> {
  const items = [...group.items].sort((a, b) => cost(a) - cost(b));
  if (!items.length) return true;
  for (const item of items) {
    let ok: boolean;
    if (isGroup(item)) ok = await evaluateGroup(item, env);
    else {
      const started = Date.now();
      let details: Record<string, unknown>;
      try {
        [ok, details] = await evaluateOne(item, env);
      } catch (err) {
        ok = false;
        details = { error: err instanceof Error ? err.message : String(err) };
      }
      env.steps.push({ idx: env.steps.length, kind: 'condition', name: conditionLabel(item), status: ok ? 'matched' : 'not_matched', details, durationMs: Date.now() - started });
    }
    if (group.op === 'all' && !ok) return false;
    if (group.op === 'any' && ok) return true;
  }
  return group.op === 'all';
}

/** Whether a group contains an AI question (dry runs show the tokens). */
export function hasAiQuestion(group: ConditionGroup): boolean {
  return group.items.some((i) => (isGroup(i) ? hasAiQuestion(i) : i.type === 'ai_question'));
}

// ---------------------------------------------------------------- AI

const QUESTION_SYSTEM = `You answer a yes/no question about one document of a personal archive.
Reply with JSON only: {"answer": true or false, "reason": "one short sentence"}.
Answer true only when the document clearly supports it.`;

const EXTRACT_SYSTEM = `You extract one value from a document of a personal archive.
Reply with JSON only: {"value": string or null, "reason": "one short sentence"}.
Use null when the document does not contain the value. Dates as YYYY-MM-DD, amounts as plain numbers with a dot.`;

function documentBlock(env: EvalEnv): string {
  const { doc, meta } = env.subject;
  const budget = Math.min(6000, Math.floor(contextBudget(env.ctx.cfg.ai) / 2));
  const text = truncateToTokens(documentText(env.ctx, doc), budget).text;
  const head = [`Title: ${doc.title ?? ''}`, `Correspondent: ${meta.correspondentName(doc.correspondent) ?? '–'}`, `Document type: ${meta.documentTypeName(doc.document_type) ?? '–'}`, `Date: ${(doc.created_date ?? doc.created ?? '').slice(0, 10) || '–'}`];
  return `${head.join('\n')}\n\nText:\n"""\n${text}\n"""`;
}

async function aiCall<T>(env: EvalEnv, system: string, task: string, cacheKey: string): Promise<T & { cached: boolean }> {
  const { doc } = env.subject;
  const modified = doc.modified ?? '';
  const cached = env.ctx.repos.workflows.cachedAnswer<T>(doc.id, modified, cacheKey);
  if (cached) return { ...cached, cached: true };
  const res = await env.ctx.llm().complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: `${task}\n\n${documentBlock(env)}` },
    ],
    { json: true, temperature: 0, maxTokens: 300, signal: env.signal, timeoutMs: 60_000 },
  );
  env.ctx.recordUsage('workflow', res, doc.id);
  env.tokens.used += res.usage.totalTokens;
  const parsed = extractJsonObject<T>(res.text);
  env.ctx.repos.workflows.cacheAnswer(doc.id, modified, cacheKey, parsed);
  return { ...parsed, cached: false };
}

export async function askAi(env: EvalEnv, question: string): Promise<{ answer: boolean; reason: string; cached: boolean }> {
  const r = await aiCall<{ answer?: unknown; reason?: unknown }>(env, QUESTION_SYSTEM, `Question: ${question}`, `q:${question}`);
  const answer = r.answer === true || (typeof r.answer === 'string' && /^(true|yes|ja)$/i.test(r.answer.trim()));
  return { answer, reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : '', cached: r.cached };
}

export async function extractWithAi(env: EvalEnv, question: string): Promise<{ value: string | null; reason: string; cached: boolean }> {
  const r = await aiCall<{ value?: unknown; reason?: unknown }>(env, EXTRACT_SYSTEM, `Extract: ${question}`, `x:${question}`);
  const value = r.value === null || r.value === undefined || r.value === '' ? null : String(r.value).slice(0, 1000);
  return { value, reason: typeof r.reason === 'string' ? r.reason.slice(0, 500) : '', cached: r.cached };
}
