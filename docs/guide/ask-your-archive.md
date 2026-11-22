# Ask your archive

← [Documentation](README.md)

*Ask your archive* answers questions in plain language over all documents: a hybrid keyword and vector search, streamed answers with cited sources, exact numbers from the archive for “how many …?” questions, and a search mode without AI costs. *Settings → Ask your archive* turns it on and chooses the embeddings.

## Choosing embeddings

| Option | Notes |
| --- | --- |
| **Local** (default) | `Xenova/multilingual-e5-small` (~120 MB, downloaded once to `data/models`), 100+ languages incl. cross-lingual search, runs on the CPU in a worker thread (≈ 0.5 GB RAM while indexing, released after 5 minutes idle) |
| Ollama | e.g. `nomic-embed-text`, `bge-m3`, `mxbai-embed-large` (`ollama pull …`) |
| OpenAI / OpenAI-compatible / Azure | e.g. `text-embedding-3-small` |
| None | keyword search only (BM25) – smallest footprint |

Changing the embedding model re-embeds the passages automatically; the keyword search keeps working meanwhile.

## Embedding prompts

Many embedding models expect a prompt in front of questions and passages. *Settings → Ask your archive* has a field for each: `{query}` stands for the question, `{text}` for the passage and `{title}` for the document title; without a placeholder the text is appended. A bare `{query}` or `{text}` means no prompt.

Left empty, these models get their prompts automatically – each found more with them in both a pure vector search and the complete search of Paperless-AI (German/English test archive): **e5** (`query: ` / `passage: `), **mxbai-embed-large**, **snowflake-arctic-embed** v1/v1.5 and **Qwen3-Embedding**. The built-in local model keeps its prompts as before. *nomic-embed-text*, *EmbeddingGemma*, *snowflake-arctic-embed2* and *e5-…-instruct* get none automatically – the complete search did not get better with them; set them yourself if you like, e.g. EmbeddingGemma `task: search result | query: {query}` and `title: none | text: {text}`.

An index built before this existed keeps working unchanged after an update. If its model now has automatic prompts, the settings offer to switch – all passages are embedded again.

Memory: the vector index keeps one byte per dimension and passage in RAM (a document has about one passage per 1,000 characters) – e.g. 100,000 passages need ≈ 40 MB with the local model (384 dimensions) and ≈ 155 MB with `text-embedding-3-small` (1,536 dimensions).

**Smart search terms** (on by default, `RAG_QUERY_EXPANSION=false` to disable): before searching, the AI adds a few search terms to the question – synonyms, names and translations into the language of your archive. This costs one short extra AI call per question and noticeably improves the hit rate, especially when you ask in a different language than your documents are written in.

Retrieval quality, measured with `npx tsx e2e/rag-eval/run.ts` (49 German/English documents, 27 questions in both languages; “hit@k” = the right document is among the first k sources the AI sees):

| Retrieval | hit@1 | hit@3 | hit@5 |
| --- | --- | --- | --- |
| Keyword only | 56 % | 70 % | 70 % |
| Hybrid, local model | 81 % | 89 % | 93 % |
| Hybrid, local model + smart search terms (`qwen2.5:3b` via Ollama) | 85 % | **100 %** | **100 %** |
