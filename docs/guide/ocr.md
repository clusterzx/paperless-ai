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

## OCR API server

*Settings → OCR → OCR API server* lets other applications send files to Paperless-AI to be read: they get the text and a searchable PDF back. It works on its own – with Paperless-ngx or the built-in archive, and also while *Enable OCR with PaddleOCR* (reading the own documents) is off. A file comes in, the models load if they are not loaded yet, the file is read, the answer goes back; the models are unloaded as *Unload the OCR models* says. Model, language, quality, device and *Max. pages per document* are the ones of the OCR settings.

All callers need an API key with the permission *OCR API* – it can only have files read, nothing else. The settings page shows the lines below with your address and creates the key with one click.

### Paperless-ngx (remote OCR)

Paperless-ngx can hand the scans it consumes to a remote OCR engine instead of reading them with Tesseract. Paperless-AI answers like Azure AI Document Intelligence, which Paperless-ngx supports for that – no Azure account is needed, nothing leaves your network. Set in Paperless-ngx:

```env
PAPERLESS_REMOTE_OCR_ENGINE=azureai
PAPERLESS_REMOTE_OCR_ENDPOINT=http://paperless-ai:3000
PAPERLESS_REMOTE_OCR_API_KEY=<API key of Paperless-AI with the permission "OCR API">
```

The endpoint is the address at which Paperless-ngx reaches Paperless-AI (here: the same Docker network). Paperless-ngx then sends each scan and photo, stores the searchable PDF as its archive file and the text as the content. The document arrives with good text, so the AI analysis after the webhook uses it right away. Digital PDFs keep their own text and are not sent.

- **Availability:** while Paperless-AI cannot be reached, Paperless-ngx cannot consume scans – it stops with an error instead of storing a document without text (try again from its file tasks). When the OCR itself fails, Paperless-ngx gets the file without text, and Paperless-AI's own OCR (*When should OCR run?*) can read the document once it has arrived.
- **Not read twice:** a document whose text came from the OCR API server is not read again by Paperless-AI, also not in the mode *Every document*.
- **Existing documents:** the remote OCR covers new documents; for the existing ones use the *OCR* page or *When should OCR run?*.

### Other apps

`POST /api/ocr/read` reads a PDF or an image and answers once it is done – the file as the multipart field `file`, or as the body with its content type:

```bash
curl -H "x-api-key: <key>" -F file=@scan.pdf "http://paperless-ai:3000/api/ocr/read?format=pdf" -o scan-searchable.pdf
```

| `format` | Answer |
| --- | --- |
| `json` (default) | `text`, and per page its `text` and `lines` – each with `text` and `box`: the corners top left, top right, bottom right, bottom left in reading order, as fractions of the page (0…1, origin top left) |
| `text` | the text |
| `pdf` | the searchable PDF (an image becomes a PDF) |

A file that cannot be read answers `422` with the reason. Apps that support Azure AI Document Intelligence use the address of Paperless-AI as their endpoint (model `prebuilt-read`).

Files are read one after the other – an A4 page takes 1–2 s on a 4-core CPU; the *OCR* page shows how many files the OCR API server read in the last 24 hours.

## Searchable PDF

*Settings → OCR → Make searchable PDFs* lays the OCR text into the PDF as an invisible text layer, in the places where PaddleOCR read it. The page looks exactly as before; search, select and copy work in every PDF viewer (also on the phone). Off by default.

- **Built-in archive:** the searchable PDF becomes the archive PDF of the document – it is shown and downloaded, the original stays as it is (*Download → original*). Images (JPEG, PNG, TIFF …) become a PDF; JPEG photos keep their image data.
- **Paperless-ngx:** the searchable PDF is uploaded as a new version of the document (*OCR text layer (Paperless-AI)*); the original stays as the first version. This needs a Paperless-ngx with document versions – older ones answer that they have none, the OCR page says so and the OCR text is saved as before. Paperless-ngx reads the text of the new version from its PDF; with *Save the OCR text in Paperless* on, Paperless-AI puts the OCR text into the version once Paperless-ngx has consumed it (its line order can be better). Keep `PAPERLESS_OCR_MODE` at `skip` (the default): with `redo` or `force` Paperless-ngx replaces the text layer with its own OCR.

The PDF is made when the OCR text is used (it scores better than the existing text). Pages that already carry most of their text – a digital page, a page OCRed before – keep their own text layer; a document whose pages all have one gets no searchable PDF. *Restore the text before OCR* on the *OCR* page also takes the PDF away again (the archive PDF, or the version in Paperless-ngx). The own version is never read by the OCR again, also not in the mode *Every document*.

Skewed scans: a line turned by up to 10° from the page is written word by word along the page – each word where it lies – because PDF text extraction (pdftotext, which Paperless-ngx uses) would otherwise cut its words into pieces. Text turned further (a stamp, the spine of a folder) follows its direction.

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
