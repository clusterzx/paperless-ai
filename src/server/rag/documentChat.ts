/**
 * Chat about a single document. Short documents are sent completely; for
 * long documents the most relevant passages are selected so the prompt always
 * fits into the model's context window.
 */
import type { ChatStreamEvent, ChatTurn } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { contextBudget } from '../ai/factory.js';
import { estimateTokens, normalizeContent, truncateToTokens } from '../ai/tokens.js';
import type { ChatMessage, Usage } from '../ai/types.js';
import { datePart } from '../processing/dates.js';
import { chunkText } from './chunker.js';
import { overlapScore, queryTerms } from './text.js';

export function selectRelevantContent(content: string, question: string, budgetTokens: number): { text: string; partial: boolean } {
  if (estimateTokens(content) <= budgetTokens) return { text: content, partial: false };
  const chunks = chunkText(content, { size: 1500, overlap: 150 });
  const terms = queryTerms(question);
  const scored = chunks.map((text, idx) => ({ idx, text, score: overlapScore(text, terms) + (idx === 0 ? 0.3 : 0) }));
  const chosen: typeof scored = [];
  let used = 0;
  for (const c of [...scored].sort((a, b) => b.score - a.score)) {
    const t = estimateTokens(c.text);
    if (used + t > budgetTokens) continue;
    chosen.push(c);
    used += t;
  }
  return {
    text: chosen
      .sort((a, b) => a.idx - b.idx)
      .map((c) => c.text)
      .join('\n[…]\n'),
    partial: true,
  };
}

export async function* documentChat(
  ctx: AppContext,
  documentId: number,
  question: string,
  history: ChatTurn[],
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const cfg = ctx.cfg;
  const llm = ctx.llm();
  const meta = ctx.metadata();
  const [doc] = await Promise.all([ctx.paperless().getDocument(documentId), meta.snapshot()]);
  const content = normalizeContent(doc.content ?? '');
  const contextWindow = contextBudget(cfg.ai);
  const maxAnswer = Math.min(Math.max(cfg.ai.responseTokens, 1500), Math.floor(contextWindow / 4));

  const historyMsgs: ChatMessage[] = [];
  let historyBudget = Math.min(4000, Math.floor(contextWindow * 0.2));
  for (const turn of history.filter((t) => t.content?.trim()).slice(-12).reverse()) {
    const t = estimateTokens(turn.content);
    if (t > historyBudget) break;
    historyBudget -= t;
    historyMsgs.unshift({ role: turn.role, content: turn.content });
  }

  const facts = [
    `Title: ${doc.title}`,
    meta.correspondentName(doc.correspondent) ? `Correspondent: ${meta.correspondentName(doc.correspondent)}` : '',
    meta.documentTypeName(doc.document_type) ? `Document type: ${meta.documentTypeName(doc.document_type)}` : '',
    datePart(doc.created_date ?? doc.created) ? `Date: ${datePart(doc.created_date ?? doc.created)}` : '',
    doc.tags?.length ? `Tags: ${doc.tags.map((t) => meta.tagName(t)).filter(Boolean).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const systemBase = `You are a helpful assistant for questions about one document from the user's Paperless-ngx archive.
Answer based on the document content below. If something is not in the document, say so honestly.
Answer in the language of the user's question and use Markdown where helpful.

${facts}`;
  const budget =
    contextWindow - maxAnswer - estimateTokens(systemBase) - historyMsgs.reduce((s, m) => s + estimateTokens(m.content), 0) - estimateTokens(question) - 300;
  const selected = content ? selectRelevantContent(content, question, Math.max(300, budget)) : { text: '', partial: false };
  if (selected.partial) yield { type: 'status', message: 'The document is long – using the most relevant passages.' };
  const system = `${systemBase}\n\nDocument content${selected.partial ? ' (relevant excerpts)' : ''}:\n"""\n${
    selected.text || '(this document has no text content)'
  }\n"""`;

  const started = Date.now();
  let usage: Usage | undefined;
  let text = '';
  for await (const chunk of llm.stream([{ role: 'system', content: system }, ...historyMsgs, { role: 'user', content: truncateToTokens(question, 2000).text }], {
    temperature: Math.min(cfg.ai.temperature, 0.5),
    maxTokens: maxAnswer,
    signal,
  })) {
    if (chunk.type === 'delta') {
      text += chunk.text;
      yield { type: 'delta', text: chunk.text };
    } else usage = chunk.usage;
  }
  const finalUsage = usage ?? {
    promptTokens: estimateTokens(system),
    completionTokens: estimateTokens(text),
    totalTokens: estimateTokens(system) + estimateTokens(text),
  };
  ctx.recordUsage('chat', { usage: finalUsage, model: llm.model, durationMs: Date.now() - started }, documentId);
  yield { type: 'done', usage: finalUsage, model: llm.model };
}
