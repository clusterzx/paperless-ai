import { useCallback, useState } from 'react';

export const SECRET_MASK = '••••••••';

/** Immutable deep set by dotted path. */
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone = (o: unknown) => (Array.isArray(o) ? [...o] : { ...(o as object) });
  const root = clone(obj) as Record<string, unknown>;
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = clone(cur[keys[i]] ?? {});
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return root as T;
}

export function getIn(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export type Setter = (path: string, value: unknown) => void;

export function useDraft<T>(initial: T): [T, Setter, (v: T) => void] {
  const [draft, setDraft] = useState<T>(initial);
  const set = useCallback<Setter>((path, value) => setDraft((d) => setIn(d, path, value)), []);
  return [draft, set, setDraft];
}

/** Paths whose values differ between two configs (used for "unsaved changes"). */
export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}
