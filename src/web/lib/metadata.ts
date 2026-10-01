import { useEffect, useState } from 'react';
import { get } from './api';

export interface Metadata {
  tags: { id: number; name: string; color?: string; document_count?: number }[];
  correspondents: { id: number; name: string; document_count?: number }[];
  documentTypes: { id: number; name: string; document_count?: number }[];
  customFields: { id: number; name: string; data_type: string }[];
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
  return {
    ...m,
    loaded: data !== null,
    reload: () => setNonce((n) => n + 1),
    tagName: (id) => tags.get(id) ?? `#${id}`,
    correspondentName: (id) => (id == null ? null : (corr.get(id) ?? null)),
    documentTypeName: (id) => (id == null ? null : (types.get(id) ?? null)),
  };
}
