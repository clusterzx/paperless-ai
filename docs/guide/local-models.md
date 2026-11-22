# Local models (Ollama and others)

← [Documentation](README.md)

- **Context size:** Paperless-AI sends a fixed `num_ctx` (default 16,384 tokens). Ollama reloads the model whenever `num_ctx` changes, so a fixed size keeps it loaded between documents. Longer documents are shortened to fit; raise the size if your GPU has room, or set `0` to size it per document.
- **Thinking:** thinking models (qwen3, gpt-oss, deepseek-r1 …) can be switched off in *Settings → AI provider*, which is much faster for metadata extraction. gpt-oss also accepts `low`/`medium`/`high`.
- **Free the GPU:** *Unload the model when the queue is empty* releases the memory right after the last document; alternatively use *Keep model loaded* (`keep_alive`).
- **Other local servers** (vLLM, llama.cpp, LM Studio) run as *OpenAI-compatible* provider; parameters such as `{"chat_template_kwargs": {"enable_thinking": false}}` go into *Extra request parameters*.

Environment variables: `OLLAMA_*` and `CUSTOM_*` in [Configuration](configuration.md).
