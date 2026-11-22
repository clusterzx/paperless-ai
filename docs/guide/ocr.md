# OCR

← [Documentation](README.md)

*Settings → OCR* turns OCR on. The modes:

- **No text or poor text** (recommended): before the AI analysis, documents without text or with garbled text (text-quality score below 50) are read with OCR.
- **Only documents without text**: for archives where Paperless' own OCR is fine.
- **Every document**: best text for every document, costs time per document.
- **Manual**: only from the *OCR* page or the API (`POST /api/ocr/run`). The documents are analyzed by the AI afterwards.

The OCR text replaces the text in Paperless only when its text-quality score is higher than that of the existing text – a clean text layer of a digital PDF or well-read print is never replaced by a weaker OCR result (e.g. of handwriting); the AI then analyses the existing text, too. On the *OCR* page you can compare both texts and save the OCR text anyway.

- **Speed:** on a 4-core CPU an A4 page takes about 1–2 s (*Balanced*); *Accurate* reads small print better but is slow without a GPU. PP-OCRv6 *tiny* is about twice as fast (see below).
- **GPU memory:** on the GPU the OCR models are unloaded after each document (*Unload the OCR models: Automatic*), so a local model (Ollama, llama.cpp …) on the same GPU gets all of the memory back. Without such a model choose *After 10 idle minutes*.
- **Models** are stored in `data/models/paddleocr` and downloaded once, pinned to a fixed version; behind a proxy or offline set `HF_ENDPOINT` to a Hugging Face mirror. ONNX Runtime telemetry is switched off.

## Models: PP-OCRv5 or PP-OCRv6

*Settings → OCR → Model* chooses the generation of PaddleOCR. The *OCR* page and *Logs & diagnostics* show the model in use.

| Model | Languages | Download | Notes |
| --- | --- | --- | --- |
| **PP-OCRv5** (default) | all languages of the list | ~13 MB (*Accurate*: ~100 MB) | a recognition model per language group |
| **PP-OCRv6 tiny** | Latin script, English, Chinese – no Japanese | ~6 MB | about twice as fast as PP-OCRv5 on the CPU, least memory – for small servers and NAS |
| **PP-OCRv6 small** | Latin script, English, Chinese, Japanese | ~31 MB | about as fast as PP-OCRv5 |
| **PP-OCRv6 medium** | Latin script, English, Chinese, Japanese | ~139 MB | the most accurate, about three times slower on the CPU – best with a GPU |

*Latin script* covers German, French, Spanish, Italian, Dutch, Polish, Czech, Turkish, the Scandinavian languages and more (46 in PP-OCRv6). For Cyrillic, Greek, Arabic, Korean, Thai and the Indian scripts PP-OCRv6 has no model: with one of these languages PP-OCRv5 is used and the settings say so (as for Japanese with *tiny*).

With PP-OCRv6, *Quality* sets the resolution of the pages and the size the detector works on; the model size decides the models. The first use of a model downloads it.

Environment variables: `OCR_*` in [Configuration](configuration.md) – among them `OCR_MODEL_VERSION` (`v5`, `v6`) and `OCR_MODEL_SIZE` (`tiny`, `small`, `medium`).
