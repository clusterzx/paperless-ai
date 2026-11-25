/**
 * In-process document event bus. Emitted after a change is committed (never inside a transaction);
 * subscribers (RAG index, workflows, calendar, live UI updates) react to single documents instead
 * of polling. Events are not persisted – durable work is stored by the subscriber.
 */
import { EventEmitter } from 'node:events';
import type { ChangeOrigin, IngestChannel } from './backend/types.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'events' });

export type DocumentEvent =
  | {
      type: 'document.added';
      id: number;
      source: IngestChannel | 'scan' | 'webhook';
      libraryId?: number | null;
      /** Intake hints for the processing: store and read only, a library prompt, extra context. */
      skipAnalysis?: boolean;
      prompt?: number | string;
      context?: Record<string, string>;
    }
  | { type: 'document.updated'; id: number; fields: string[]; origin: ChangeOrigin; libraryId?: number | null }
  | { type: 'document.version_added'; id: number; version: number; libraryId?: number | null }
  | { type: 'document.deleted'; id: number; origin: ChangeOrigin; libraryId?: number | null }
  | { type: 'document.restored'; id: number; libraryId?: number | null }
  | { type: 'document.purged'; id: number; libraryId?: number | null }
  | { type: 'document.processed'; id: number; historyId: number | null; libraryId?: number | null };

export type DocumentEventType = DocumentEvent['type'];

/** Progress of an intake attempt (upload, watch folder, mail …) for the inbox page. */
export interface IntakeEvent {
  intakeId: number;
  status: 'pending' | 'stored' | 'duplicate' | 'failed' | 'rejected';
  documentId?: number | null;
  filename?: string | null;
  libraryId?: number | null;
  /** The user who sent the file (an attempt without a library is shown to them and administrators). */
  createdBy?: number | null;
  /** Why it was refused, failed or is a duplicate. */
  reason?: string | null;
}

export class DocumentEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: DocumentEvent): void {
    // Listeners must never break the code that emitted the event.
    for (const listener of this.emitter.listeners('event') as ((e: DocumentEvent) => void)[]) {
      try {
        listener(event);
      } catch (err) {
        log.error({ err, event: event.type }, 'Document event listener failed');
      }
    }
  }

  /** Subscribe to all events; returns the unsubscribe function. */
  on(listener: (e: DocumentEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  emitIntake(event: IntakeEvent): void {
    for (const listener of this.emitter.listeners('intake') as ((e: IntakeEvent) => void)[]) {
      try {
        listener(event);
      } catch (err) {
        log.error({ err }, 'Intake event listener failed');
      }
    }
  }

  onIntake(listener: (e: IntakeEvent) => void): () => void {
    this.emitter.on('intake', listener);
    return () => this.emitter.off('intake', listener);
  }
}
