import { useEffect, useRef } from 'react';
import type { LiveEvent } from '@shared/api';

/**
 * Live events of the server (documents added, changed, deleted, processed; intake progress).
 * One EventSource per hook; the browser reconnects on its own after network errors.
 */
export function useLiveEvents(handler: (e: LiveEvent) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    source.onmessage = (msg) => {
      try {
        ref.current(JSON.parse(msg.data) as LiveEvent);
      } catch {
        /* keep-alive or malformed */
      }
    };
    return () => source.close();
  }, [enabled]);
}
