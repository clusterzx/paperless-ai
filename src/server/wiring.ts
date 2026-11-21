/**
 * Connects the services through the document event bus. Used by the server (index.ts) and the test
 * harness, so both run with the same reactions to document changes.
 */
import type { AppContext } from './context.js';
import type { RagService } from './rag/service.js';
import type { OcrService } from './ocr/service.js';
import type { ProcessingEngine } from './processing/engine.js';
import { rulePrompt } from './processing/promptRules.js';

/** Text of a library prompt given by id or name (intake hint). */
function promptText(ctx: AppContext, prompt: number | string): string | undefined {
  return rulePrompt(ctx, { prompt })?.prompt;
}
import { logger } from './logger.js';

const log = logger.child({ module: 'events' });

export interface WiredServices {
  rag: RagService;
  ocr: OcrService;
  engine?: ProcessingEngine;
}

/** Subscribe the services to document events. Returns the unsubscribe function. */
export function wireDocumentEvents(ctx: AppContext, { rag, ocr, engine }: WiredServices): () => void {
  ocr.onTextChanged = (id) => rag.invalidate(id);
  return ctx.events.on((e) => {
    switch (e.type) {
      case 'document.deleted':
      case 'document.purged':
        // Gone from the archive: out of the search index and the calendar right away.
        rag.invalidate(e.id);
        ctx.repos.calendar.removeDocument(e.id);
        break;
      case 'document.added':
        // New documents of the built-in archive go straight into the processing queue (OCR when
        // needed, then the AI analysis) – no waiting for the next scan.
        if (engine && e.source !== 'scan' && e.source !== 'webhook' && ctx.archiveMode() === 'builtin') {
          const prompt = e.prompt !== undefined ? promptText(ctx, e.prompt) : undefined;
          engine.enqueue(e.id, { source: 'ingest', analyze: !e.skipAnalysis, prompt });
        }
        rag.requestSync();
        break;
      case 'document.version_added':
        if (engine && ctx.archiveMode() === 'builtin') {
          const lib = e.libraryId != null ? ctx.repos.libraries.get(e.libraryId) : undefined;
          engine.enqueue(e.id, { source: 'ingest', force: true, analyze: Boolean(lib?.settings.reanalyzeOnNewVersion) });
        }
        rag.requestSync();
        break;
      case 'document.restored':
        rag.requestSync();
        break;
      case 'document.updated':
        // AI changes are indexed when the queue is idle; user and workflow changes right away.
        if (e.origin.actor !== 'ai') rag.requestSync();
        break;
      default:
        break;
    }
    log.debug({ event: e.type, id: e.id }, 'Document event');
  });
}
