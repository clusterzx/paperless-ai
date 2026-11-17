/**
 * Process-wide defaults that must be in place before any native library is
 * loaded. Imported first by the entry point.
 */

// ONNX Runtime (OCR, local embeddings) collects usage telemetry and stores a device id in
// ~/.cache/Microsoft by default. Paperless-AI processes private documents: keep it off unless
// the user explicitly sets ORT_DISABLE_TELEMETRY=0.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
