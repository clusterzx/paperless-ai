import { useEffect, useRef, useState } from 'react';
import { get } from './api';

export interface Metadata {
  tags: { id: number; name: string; color?: string; document_count?: number }[];
  correspondents: { id: number; name: string; document_count?: number }[];
  documentTypes: { id: number; name: string; document_count?: number }[];
  customFields: CustomFieldMeta[];
}

export interface CustomFieldMeta {
  id: number;
  name: string;
  data_type: string;
  /** Currency of monetary fields, options of select fields (old Paperless-ngx: plain strings, the value is the index). */
  extra_data?: { default_currency?: string | null; select_options?: ({ id: string; label: string } | string)[] } | null;
}

let cache: { at: number; promise: Promise<Metadata> } | null = null;

export function loadMetadata(force = false): Promise<Metadata> {
  if (!cache || force || Date.now() - cache.at > 60_000) {
    const promise = get<Metadata>('/api/metadata');
    cache = { at: Date.now(), promise };
    promise.catch(() => {
      cache = null;
    });
  }
  return cache.promise;
}

export interface MetadataLookup extends Metadata {
  tagName: (id: number) => string;
  correspondentName: (id: number | null | undefined) => string | null;
  documentTypeName: (id: number | null | undefined) => string | null;
}

const empty: Metadata = { tags: [], correspondents: [], documentTypes: [], customFields: [] };

export function useMetadata(): MetadataLookup & { loaded: boolean; reload: () => void } {
  const [data, setData] = useState<Metadata | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    loadMetadata(nonce > 0)
      .then((m) => alive && setData(m))
      .catch(() => alive && setData(empty));
    return () => {
      alive = false;
    };
  }, [nonce]);
  const m = data ?? empty;
  const tags = new Map(m.tags.map((t) => [t.id, t.name]));
  const corr = new Map(m.correspondents.map((t) => [t.id, t.name]));
  const types = new Map(m.documentTypes.map((t) => [t.id, t.name]));

  // An id that is not in the (cached) lists was created since they were loaded – typically a
  // correspondent or tag the AI just added. Load the lists again, once per unknown id.
  const unknown = useRef(new Set<string>());
  const retried = useRef(new Set<string>());
  unknown.current.clear();
  const lookup = (map: Map<number, string>, kind: string, id: number): string | undefined => {
    const name = map.get(id);
    if (name === undefined && data) unknown.current.add(`${kind}:${id}`);
    return name;
  };
  // After every render (the lookups happen while rendering); `retried` bounds it to one load per id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const fresh = [...unknown.current].filter((k) => !retried.current.has(k));
    if (!fresh.length) return;
    for (const k of fresh) retried.current.add(k);
    setNonce((n) => n + 1);
  });

  return {
    ...m,
    loaded: data !== null,
    reload: () => setNonce((n) => n + 1),
    tagName: (id) => lookup(tags, 't', id) ?? `#${id}`,
    correspondentName: (id) => (id == null ? null : (lookup(corr, 'c', id) ?? null)),
    documentTypeName: (id) => (id == null ? null : (lookup(types, 'd', id) ?? null)),
  };
}
