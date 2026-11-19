import { describe, expect, it } from 'vitest';
import { applyDocumentPrompt, applyQueryPrompt, autoEmbeddingPrompts, promptTemplate } from '../../src/shared/embeddingPrompts.js';
import { legacyEmbeddingPrompts } from '../../src/server/ai/factory.js';

const REPRESENT = 'Represent this sentence for searching relevant passages: ';
const QWEN = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

describe('embedding prompts', () => {
  it('knows the prompts of embedding models with a measured benefit (Ollama, OpenAI-compatible, Azure)', () => {
    const cases: [string, string, string][] = [
      ['intfloat/multilingual-e5-small', 'query: ', 'passage: '],
      ['jeffh/intfloat-multilingual-e5-large:f16', 'query: ', 'passage: '],
      ['mxbai-embed-large', REPRESENT, ''],
      ['mixedbread-ai/mxbai-embed-large-v1', REPRESENT, ''],
      ['qwen3-embedding:0.6b', QWEN, ''],
      ['Qwen/Qwen3-Embedding-8B', QWEN, ''],
      ['snowflake-arctic-embed:335m', REPRESENT, ''],
      ['Snowflake/snowflake-arctic-embed-m-v1.5', REPRESENT, ''],
      // no benefit in the complete search: no automatic prompts
      ['nomic-embed-text', '', ''],
      ['text-embedding-nomic-embed-text-v1.5', '', ''],
      ['embeddinggemma:300m', '', ''],
      ['google/embeddinggemma-2', '', ''],
      ['snowflake-arctic-embed2', '', ''],
      ['Snowflake/snowflake-arctic-embed-l-v2.0', '', ''],
      ['intfloat/multilingual-e5-large-instruct', '', ''],
      // models without prompts
      ['bge-m3', '', ''],
      ['granite-embedding:278m', '', ''],
      ['text-embedding-3-small', '', ''],
      ['all-minilm', '', ''],
    ];
    for (const provider of ['ollama', 'custom', 'openai', 'azure']) {
      for (const [model, query, document] of cases) expect(autoEmbeddingPrompts(provider, model), `${provider} ${model}`).toEqual({ query, document });
    }
    expect(autoEmbeddingPrompts('none', 'mxbai-embed-large')).toEqual({ query: '', document: '' });
  });

  it('gives the built-in local model exactly the prompts it had before', () => {
    const models = ['Xenova/multilingual-e5-small', 'Xenova/multilingual-e5-base', 'nomic-ai/nomic-embed-text-v1.5', 'mixedbread-ai/mxbai-embed-large-v1', 'Xenova/bge-m3', 'Snowflake/snowflake-arctic-embed-m-v1.5'];
    for (const model of models) expect(autoEmbeddingPrompts('local', model), model).toEqual(legacyEmbeddingPrompts('local', model));
  });

  it('puts questions and passages into prompts and templates', () => {
    expect(applyQueryPrompt('', 'Wann?')).toBe('Wann?');
    expect(applyQueryPrompt('search_query: ', 'Wann?')).toBe('search_query: Wann?');
    expect(applyQueryPrompt('task: search | query: {query}', 'Wann?')).toBe('task: search | query: Wann?');
    expect(applyDocumentPrompt('', 'Text', 'Title')).toBe('Text');
    expect(applyDocumentPrompt('passage: ', 'Text', 'Title')).toBe('passage: Text');
    expect(applyDocumentPrompt('title: {title} | text: {text}', 'Text', 'Rechnung')).toBe('title: Rechnung | text: Text');
    expect(applyDocumentPrompt('title: {title} | text: ', 'Text', '')).toBe('title: none | text: Text');
    expect(applyDocumentPrompt('{content} (end)', 'Text', 'T')).toBe('Text (end)');
    // replacement patterns in the text are not interpreted
    expect(applyQueryPrompt('q: {query}', 'costs $& $1')).toBe('q: costs $& $1');
    expect(applyDocumentPrompt('d: {text} {title}', 'costs $&', '$1')).toBe('d: costs $& $1');
  });

  it('shows prompts as templates', () => {
    expect(promptTemplate('search_query: ', '{query}')).toBe('search_query: {query}');
    expect(promptTemplate('', '{text}')).toBe('{text}');
    expect(promptTemplate('title: {title} | text: {content}', '{text}')).toBe('title: {title} | text: {content}');
  });
});
