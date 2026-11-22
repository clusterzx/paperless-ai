# OCR

← [Documentation](README.md)

*Settings → OCR* turns OCR on. The modes:

- **No text or poor text** (recommended): before the AI analysis, documents without text or with garbled text (text-quality score below 50) are read with OCR.
- **Only documents without text**: for archives where Paperless' own OCR is fine.
- **Every document**: best text for every document, costs time per document.
- **Manual**: only from the *OCR* page or the API (`POST /api/ocr/run`). The documents are analyzed by the AI afterwards.

The OCR text replaces the text in Paperless only when its text-quality score is higher than that of the existing text – a clean text layer of a digital PDF or well-read print is never replaced by a weaker OCR result (e.g. of handwriting); the AI then analyses the existing text, too. On the *OCR* page you can compare both texts and save the OCR text anyway.

- **Speed:** on a 4-core CPU an A4 page takes about 1–2 s (*Balanced*); *Accurate* reads small print better but is slow without a GPU.
- **GPU memory:** on the GPU the OCR models are unloaded after each document (*Unload the OCR models: Automatic*), so a local model (Ollama, llama.cpp …) on the same GPU gets all of the memory back. Without such a model choose *After 10 idle minutes*.
- **Models** (~20 MB) are stored in `data/models/paddleocr` and downloaded once; behind a proxy or offline set `HF_ENDPOINT` to a Hugging Face mirror. ONNX Runtime telemetry is switched off.

Environment variables: `OCR_*` in [Configuration](configuration.md).
