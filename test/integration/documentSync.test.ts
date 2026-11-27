/**
 * What sync clients need from /api/documents (#1047): SHA-256 of the files in the list, the detail
 * and the versions; ETag and If-None-Match on the file; documents changed since a moment; all ids
 * (to find deletions after being offline) – in the built-in archive and with Paperless-ngx.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import type { DocumentDetail, DocumentListResponse, DocumentVersionInfo } from '../../src/shared/api.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('sync helpers in the built-in archive', () => {
  it('shows checksums, answers If-None-Match, lists changes since a moment and all ids', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const local = h.ctx.archive() as LocalBackend;
    const files = [makePdf([['Rechnung eins']]), makePdf([['Rechnung zwei']])];
    const ids: number[] = [];
    for (const [i, data] of files.entries()) ids.push((await local.ingest(SYSTEM_SCOPE, { data, filename: `r${i}.pdf` }, 'api', { skipAnalysis: true })).documentId!);
    const get = async <T>(url: string, headers: Record<string, string> = { cookie }) => (await h.inject({ method: 'GET', url, headers })).json() as T;

    // List and detail: the SHA-256 of the stored file (no archived PDF: sha256 = original).
    const list = await get<DocumentListResponse>('/api/documents?sort=added');
    const row = list.results.find((r) => r.id === ids[0])!;
    expect(row).toMatchObject({ original_sha256: sha(files[0]), archive_sha256: null, sha256: sha(files[0]) });
    expect((await get<DocumentDetail>(`/api/documents/${ids[0]}`)).sha256).toBe(sha(files[0]));
    // Versions: per file.
    const versions = await get<DocumentVersionInfo[]>(`/api/documents/${ids[0]}/versions`);
    expect(versions[0]).toMatchObject({ version: 1, kind: 'original', sha256: sha(files[0]) });

    // The file: ETag and Repr-Digest; an unchanged file is not sent again.
    const file = await h.inject({ method: 'GET', url: `/api/documents/${ids[0]}/file`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers.etag).toBe(`"${sha(files[0])}"`);
    expect(file.headers['repr-digest']).toBe(`sha-256=:${createHash('sha256').update(files[0]).digest('base64')}:`);
    expect(sha(file.rawPayload)).toBe(sha(files[0]));
    const unchanged = await h.inject({ method: 'GET', url: `/api/documents/${ids[0]}/file`, headers: { cookie, 'if-none-match': `W/"x", "${sha(files[0])}"` } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload.length).toBe(0);
    expect(unchanged.headers.etag).toBe(`"${sha(files[0])}"`);
    const other = await h.inject({ method: 'GET', url: `/api/documents/${ids[0]}/file`, headers: { cookie, 'if-none-match': '"0000"' } });
    expect(other.statusCode).toBe(200);

    // Changed since a moment: only the document edited afterwards.
    await new Promise((r) => setTimeout(r, 5));
    const since = new Date().toISOString();
    await h.inject({ method: 'PATCH', url: `/api/documents/${ids[1]}`, headers: { cookie }, payload: { title: 'Geändert' } });
    const changed = await get<DocumentListResponse>(`/api/documents?modifiedFrom=${encodeURIComponent(since)}`);
    expect(changed.results.map((r) => r.id)).toEqual([ids[1]]);
    expect((await get<{ ids: number[] }>(`/api/documents/ids?modifiedFrom=${encodeURIComponent(since)}`)).ids).toEqual([ids[1]]);
    expect((await get<DocumentListResponse>('/api/documents?modifiedFrom=2000-01-01')).results).toHaveLength(2);
    expect((await h.inject({ method: 'GET', url: '/api/documents?modifiedFrom=yesterday', headers: { cookie } })).statusCode).toBe(400);

    // All ids: a deleted document is missing – also for an API key.
    expect((await get<{ ids: number[] }>('/api/documents/ids')).ids).toEqual(ids);
    await h.inject({ method: 'DELETE', url: `/api/documents/${ids[0]}`, headers: { cookie } });
    expect((await get<{ ids: number[] }>('/api/documents/ids', h.apiKeyHeaders())).ids).toEqual([ids[1]]);
  });
});

describe('sync helpers with Paperless-ngx', () => {
  it('has no checksums in the list, but an ETag of the file and all ids', async () => {
    h = await createHarness();
    const auth = h.apiKeyHeaders();
    h.paperless.addDocument({ id: 7, title: 'Strom' });
    h.paperless.addDocument({ id: 3, title: 'Wasser' });
    const list = (await h.inject({ method: 'GET', url: '/api/documents', headers: auth })).json() as DocumentListResponse;
    expect(list.results[0]).toMatchObject({ original_sha256: null, archive_sha256: null, sha256: null });
    const file = await h.inject({ method: 'GET', url: '/api/documents/7/file', headers: auth });
    expect(file.statusCode).toBe(200);
    expect(file.headers.etag).toBe(`"${sha(file.rawPayload)}"`);
    const again = await h.inject({ method: 'GET', url: '/api/documents/7/file', headers: { ...auth, 'if-none-match': String(file.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect(((await h.inject({ method: 'GET', url: '/api/documents/ids', headers: auth })).json() as { ids: number[] }).ids).toEqual([3, 7]);
  });
});
