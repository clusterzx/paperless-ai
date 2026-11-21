/**
 * Connects the services through the document event bus. Used by the server (index.ts) and the test
 * harness, so both run with the same reactions to document changes.
 */
import type { AppContext } from './context.js';
import type { RagService } from './rag/service.js';
import type { OcrService } from './ocr/service.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'events' });

export interface WiredServices {
  rag: RagService;
  ocr: OcrService;
}

/** Subscribe the services to document events. Returns the unsubscribe function. */
export function wireDocumentEvents(ctx: AppContext, { rag, ocr }: WiredServices): () => void {
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
      case 'document.restored':
      case 'document.version_added':
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
