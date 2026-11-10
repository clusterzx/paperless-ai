import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | undefined | ((prev: T | undefined) => T | undefined)) => void;
}

/** Load data with an async function; re-runs when deps change. Stale responses are ignored. */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const ctrl = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    try {
      const result = await fnRef.current(c.signal);
      if (!c.signal.aborted) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (!c.signal.aborted) setError(errorMessage(err));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

/** Run a callback periodically while the page is visible. */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isQuotaError = (err: unknown) => err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');

/**
 * State persisted in localStorage. When the storage quota is exceeded, `shrink` can make the value
 * smaller (e.g. drop the oldest entries; return null to give up) so it can still be saved.
 */
export function useLocalStorage<T>(key: string, initial: T, shrink?: (v: T) => T | null): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const shrinkRef = useRef(shrink);
  shrinkRef.current = shrink;
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        let next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        for (;;) {
          try {
            localStorage.setItem(key, JSON.stringify(next));
            break;
          } catch (err) {
            /* quota / private mode */
            const smaller = isQuotaError(err) ? (shrinkRef.current?.(next) ?? null) : null;
            if (smaller === null) break;
            next = smaller;
          }
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

// ------------------------------------------------------------------ unsaved changes

let unsavedChanges = 0;

/** True while a page has unsaved changes (checked before in-app navigation). */
export const hasUnsavedChanges = () => unsavedChanges > 0;

/** Warn before the page is closed or reloaded – and, via `hasUnsavedChanges`, before in-app navigation – while `dirty`. */
export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    unsavedChanges++;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      unsavedChanges--;
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);
}
