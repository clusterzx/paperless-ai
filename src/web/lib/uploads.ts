/**
 * Uploads of the web interface, outside of any page – hundreds of files at once:
 * - The files are sent a few at a time and the server answers as soon as it has kept a file
 *   (`background=true`): sending never waits for the storing, reading or converting of other files.
 * - The server stores them in the background, in order; the analysis of the first ones starts while
 *   the others are still being sent. The outcome of each file is fetched from /api/intake.
 * - They go on when another page is opened; leaving the app is warned about while files have not
 *   reached the server yet (only those would be lost).
 */
import { useSyncExternalStore } from 'react';
import type { UploadResult } from '@shared/api';
import { APP_HEADER, get } from './api';

export type UploadState = 'queued' | 'sending' | 'processing' | 'done' | 'error';

export interface UploadItem {
  key: string;
  file: File;
  fields: Record<string, string>;
  /** queued: waits to be sent · sending · processing: on the server, being stored · done: with its result · error: not sent */
  state: UploadState;
  /** Share of the file sent (0–1). */
  progress: number;
  result?: UploadResult;
  error?: string;
}

/** Files sent at the same time (browsers allow 6 connections per server without HTTP/2). */
const PARALLEL = 3;
/** How often the outcome of files on the server is looked up. */
const POLL_MS = 2000;

let items: UploadItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function update(key: string, patch: Partial<UploadItem>): void {
  items = items.map((it) => (it.key === key ? { ...it, ...patch } : it));
  emit();
}

/** Send one file with progress (fetch cannot report upload progress). */
function send(it: UploadItem): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(it.fields)) form.append(k, v);
    form.append('file', it.file, it.file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents/upload?background=true');
    for (const [name, value] of Object.entries(APP_HEADER)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && update(it.key, { progress: e.loaded / e.total });
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { results?: UploadResult[]; error?: string };
        if (xhr.status >= 400 || !body.results) reject(new Error(body.error ?? `Upload failed (HTTP ${xhr.status})`));
        else resolve(body.results[0]);
      } catch {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

function pump(): void {
  while (items.filter((i) => i.state === 'sending').length < PARALLEL) {
    // The oldest waiting file first.
    const next = [...items].reverse().find((i) => i.state === 'queued');
    if (!next) return;
    update(next.key, { state: 'sending' });
    send(next)
      .then((result) => {
        // queued: kept by the server, stored in the background (the outcome comes with poll()).
        update(next.key, { state: result.status === 'queued' && result.intakeId ? 'processing' : 'done', progress: 1, result });
        schedulePoll();
      })
      .catch((err: unknown) => update(next.key, { state: 'error', error: err instanceof Error ? err.message : String(err) }))
      .finally(pump);
  }
}

let polling: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (polling || !items.some((i) => i.state === 'processing')) return;
  polling = setTimeout(() => {
    void poll().finally(() => {
      polling = null;
      schedulePoll();
    });
  }, POLL_MS);
}

interface IntakeRow {
  id: number;
  status: string;
  documentId: number | null;
  error: string | null;
}

/** The outcome of the files the server is still storing. */
async function poll(): Promise<void> {
  const waiting = items.filter((i) => i.state === 'processing' && i.result?.intakeId);
  for (let at = 0; at < waiting.length; at += 200) {
    const batch = waiting.slice(at, at + 200);
    try {
      const rows = await get<IntakeRow[]>(`/api/intake?limit=500&ids=${batch.map((i) => i.result!.intakeId).join(',')}`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const it of batch) {
        const row = byId.get(it.result!.intakeId!);
        if (!row || row.status === 'pending') continue;
        update(it.key, {
          state: 'done',
          result: {
            ...it.result!,
            status: row.status as UploadResult['status'],
            documentId: row.documentId ?? undefined,
            reason: row.error ?? undefined,
          },
        });
      }
    } catch {
      /* the next poll tries again */
    }
  }
}

/** Queue files for upload (with the same form fields: library, tags …). */
export function enqueueUploads(files: File[], fields: Record<string, string>): void {
  const fresh = files.map((file): UploadItem => ({
    key: `${file.name}-${file.size}-${Math.random()}`,
    file,
    fields,
    state: 'queued',
    progress: 0,
  }));
  items = [...fresh.reverse(), ...items];
  emit();
  pump();
}

/** Remove the finished uploads from the list. */
export function clearFinishedUploads(): void {
  items = items.filter((i) => i.state !== 'done' && i.state !== 'error');
  emit();
}

/** Files that have not fully reached the server yet (closing the page would lose them). */
export function unsentUploads(): number {
  return items.filter((i) => i.state === 'queued' || i.state === 'sending').length;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** All uploads of this browser tab, newest first. */
export function useUploads(): UploadItem[] {
  return useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!unsentUploads()) return;
    e.preventDefault();
    // Older browsers show the dialog only with returnValue set.
    e.returnValue = '';
  });
}
