/**
 * Prompts that embedding models expect in front of questions and document passages. Many models
 * are trained with them and find less without. Used on the server (embedding) and in the settings
 * (to show what "automatic" means for a model).
 *
 * Automatic prompts for embedding APIs (Ollama, OpenAI-compatible, Azure) only for model families
 * that found more with them in both measurements of the retrieval evaluation (German/English
 * archive): pure vector search and the complete hybrid search of Paperless-AI. Without a benefit in
 * the complete search – and therefore without automatic prompts: nomic-embed-text, EmbeddingGemma,
 * snowflake-arctic-embed v2.0, e5-…-instruct. Their prompts can be set in the settings.
 */
export interface EmbeddingPrompts {
  /** In front of the question; `{query}` marks where the question goes (otherwise it is appended). */
  query: string;
  /** In front of each passage; `{text}` (or `{content}`) and `{title}` are replaced, otherwise the text is appended. */
  document: string;
}

export const NO_EMBEDDING_PROMPTS: EmbeddingPrompts = { query: '', document: '' };

/** The embedding model used when none is set (Azure needs the name of a deployment). */
export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  local: 'Xenova/multilingual-e5-small',
  openai: 'text-embedding-3-small',
  custom: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
};

const SEARCH_INSTRUCTION = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';
const REPRESENT_QUERY = 'Represent this sentence for searching relevant passages: ';

/**
 * The prompts used automatically, recognised by the model name (Ollama, Hugging Face, LM Studio …).
 * The built-in local model keeps exactly the rules it always had.
 */
export function autoEmbeddingPrompts(provider: string, model: string): EmbeddingPrompts {
  const m = model.toLowerCase();
  if (provider === 'none') return NO_EMBEDDING_PROMPTS;
  if (provider === 'local') {
    if (m.includes('e5')) return { query: 'query: ', document: 'passage: ' };
    if (m.includes('nomic-embed')) return { query: 'search_query: ', document: 'search_document: ' };
    if (m.includes('mxbai-embed')) return { query: REPRESENT_QUERY, document: '' };
    return NO_EMBEDDING_PROMPTS;
  }
  if (m.includes('qwen3-embedding')) return { query: SEARCH_INSTRUCTION, document: '' };
  if (m.includes('mxbai-embed')) return { query: REPRESENT_QUERY, document: '' };
  // v1 and v1.5 ("snowflake-arctic-embed", "…-m-v1.5"), not v2.0 ("snowflake-arctic-embed2", "…-l-v2.0")
  if (m.includes('arctic-embed') && !/arctic-embed2|arctic-embed-[a-z]+-v2/.test(m)) return { query: REPRESENT_QUERY, document: '' };
  if (/(^|[^a-z0-9])e5([^a-z0-9]|$)/.test(m) && !m.includes('instruct')) return { query: 'query: ', document: 'passage: ' };
  return NO_EMBEDDING_PROMPTS;
}

export function samePrompts(a: EmbeddingPrompts, b: EmbeddingPrompts): boolean {
  return a.query === b.query && a.document === b.document;
}

/** The question as it is embedded. */
export function applyQueryPrompt(prompt: string, query: string): string {
  return prompt.includes('{query}') ? prompt.replace(/\{query\}/g, () => query) : prompt + query;
}

/** A passage as it is embedded. */
export function applyDocumentPrompt(prompt: string, text: string, title: string): string {
  const withTitle = prompt.replace(/\{title\}/g, () => title.trim() || 'none');
  return /\{(text|content)\}/.test(withTitle) ? withTitle.replace(/\{(?:text|content)\}/g, () => text) : withTitle + text;
}

/** A prompt in template form for display ("search_query: {query}"). */
export function promptTemplate(prompt: string, placeholder: '{query}' | '{text}'): string {
  if (prompt.includes(placeholder) || (placeholder === '{text}' && prompt.includes('{content}'))) return prompt;
  return prompt + placeholder;
}
