/**
 * The MCP server (/mcp) with the official MCP client over HTTP, the stdio bridge, and the finer API
 * key permissions (delete, metadata, mcp, rate limit) in the whole API.
 */
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE, type ApiScope } from '../../src/server/access/scope.js';
import { bridgeOptions, runBridge } from '../../src/server/mcp/bridge.mjs';

let h: Harness;
let cookie: string;

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;

async function addDocument(title: string, text: string, hints: { tags?: string[]; correspondent?: string; created?: string } = {}) {
  const lines = [text, 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Unterlagen zu Ihrem Vorgang.', 'Mit freundlichen Grüßen, Ihre Verwaltung'];
  const res = await local().ingest(SYSTEM_SCOPE, { data: makePdf([lines]), filename: `${title}.pdf` }, 'upload', { title, skipAnalysis: true, ...hints });
  expect(res.status).toBe('stored');
  return res.documentId!;
}

async function newKey(scopes: ApiScope[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await h.inject({ method: 'POST', url: '/api/me/api-keys', headers: { cookie }, payload: { name: `Agent ${scopes.join('+')}`, scopes, ...extra } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().key as string;
}

async function listen(): Promise<string> {
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
}

async function connect(base: string, key: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;

const rpc = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  h.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, payload: JSON.stringify(body) });

describe('MCP server', () => {
  it('speaks MCP with the official client and offers the tools the key may use', async () => {
    const base = await listen();
    const reader = await connect(base, await newKey(['mcp', 'read']));
    expect(reader.getServerVersion()).toMatchObject({ name: 'paperless-ai', title: 'Paperless-AI' });
    expect(reader.getInstructions()).toContain('search_documents');
    const readTools = (await reader.listTools()).tools.map((t) => t.name).sort();
    expect(readTools).toEqual(['get_document', 'list_labels', 'list_libraries', 'search_documents']);
    const search = (await reader.listTools()).tools.find((t) => t.name === 'search_documents')!;
    expect(search.annotations).toMatchObject({ readOnlyHint: true });
    expect(search.inputSchema).toMatchObject({ type: 'object', properties: { query: { type: 'string' } } });
    // A tool beyond the key's permissions does not exist for it.
    await expect(reader.callTool({ name: 'delete_document', arguments: { id: 1 } })).rejects.toThrow(/Unknown tool/);
    await reader.close();

    const all = await connect(base, await newKey(['mcp', 'read', 'write', 'delete', 'metadata', 'upload', 'chat']));
    expect((await all.listTools()).tools.map((t) => t.name).sort()).toEqual(
      ['ask_documents', 'delete_document', 'find_similar_passages', 'get_document', 'list_labels', 'list_libraries', 'search_documents', 'update_document', 'upload_document'].sort(),
    );
    await all.ping();
    await all.close();
  });

  it('searches, reads and lists labels', async () => {
    const strom = await addDocument('Stromrechnung März', 'Stadtwerke Strom Abrechnung über 89,50 Euro für März', { tags: ['Rechnung', 'Strom'], correspondent: 'Stadtwerke', created: '2024-03-31' });
    await addDocument('Mietvertrag', 'Mietvertrag für die Wohnung in der Hauptstraße', { tags: ['Vertrag'], created: '2021-03-01' });
    const c = await connect(await listen(), await newKey(['mcp', 'read']));

    const found = (await call(c, 'search_documents', { query: 'strom', tags: ['Rechnung'] })).structuredContent!;
    expect(found.total).toBe(1);
    expect((found.documents as Record<string, unknown>[])[0]).toMatchObject({ id: strom, title: 'Stromrechnung März', created: '2024-03-31', correspondent: 'Stadtwerke', tags: expect.arrayContaining(['Rechnung', 'Strom']), url: expect.stringContaining(String(strom)) });
    const byDate = (await call(c, 'search_documents', { created_from: '2021-01-01', created_to: '2021-12-31' })).structuredContent!;
    expect((byDate.documents as { title: string }[]).map((d) => d.title)).toEqual(['Mietvertrag']);
    const syntax = (await call(c, 'search_documents', { query: 'correspondent:stadtwerke' })).structuredContent!;
    expect(syntax.total).toBe(1);
    expect(syntax.understood_as).toEqual([expect.stringContaining('Stadtwerke')]);

    const doc = (await call(c, 'get_document', { id: strom, max_chars: 100 })).structuredContent!;
    expect(doc).toMatchObject({ id: strom, title: 'Stromrechnung März', text: expect.stringContaining('Stadtwerke'), next_text_offset: 100 });
    expect((doc.text as string).length).toBe(100);
    const rest = (await call(c, 'get_document', { id: strom, text_offset: 100, max_chars: 100_000 })).structuredContent!;
    expect(rest.next_text_offset).toBeUndefined();
    expect((await call(c, 'get_document', { id: 9999 })).isError).toBe(true);

    const tags = (await call(c, 'list_labels', { kind: 'tags' })).structuredContent!;
    expect((tags.items as { name: string }[]).map((t) => t.name).sort()).toEqual(['Rechnung', 'Strom', 'Vertrag']);
    const invalid = await call(c, 'search_documents', { limit: 500 });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/limit/);
    await c.close();
  });

  it('changes documents within the rights of the key', async () => {
    const id = await addDocument('Brief', 'Ein Brief vom Finanzamt über die Steuererklärung', { tags: ['Post'] });
    await h.inject({ method: 'POST', url: '/api/custom-fields', headers: { cookie }, payload: { name: 'Betrag', dataType: 'monetary', currency: 'EUR' } });
    const base = await listen();
    const writer = await connect(base, await newKey(['mcp', 'read', 'write']));
    // No new labels without the right to manage them.
    const refused = await call(writer, 'update_document', { id, add_tags: ['Steuer'] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Steuer.*may not create labels/s);
    const ok = await call(writer, 'update_document', { id, title: 'Brief vom Finanzamt', created: '2024-05-02', remove_tags: ['post'] });
    expect(ok.isError, ok.content[0].text).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ changed: expect.arrayContaining(['title', 'created', 'tags']), document: { title: 'Brief vom Finanzamt', created: '2024-05-02', tags: [] } });
    await writer.close();

    const curator = await connect(base, await newKey(['mcp', 'read', 'write', 'metadata']));
    const tagged = await call(curator, 'update_document', { id, add_tags: ['Steuer'], correspondent: 'Finanzamt', custom_fields: { Betrag: '12.50' } });
    expect(tagged.isError, tagged.content[0].text).toBeFalsy();
    expect(tagged.structuredContent!.document).toMatchObject({ tags: ['Steuer'], correspondent: 'Finanzamt' });
    const doc = await local().getDocument(SYSTEM_SCOPE, id);
    expect(doc.custom_fields).toEqual([{ field: expect.any(Number), value: 'EUR12.50' }]);
    // In the change log under the key's user, and undoable there.
    const activity = (await h.inject({ method: 'GET', url: `/api/documents/${id}/activity`, headers: { cookie } })).json() as { actor: string | null; undo: unknown; details: { field: string; after: unknown }[] }[];
    expect(activity.find((a) => a.actor === 'admin' && a.details.some((d) => d.field === 'Correspondent' && d.after === 'Finanzamt'))?.undo).toBeTruthy();
    // Nothing to do: no change, no error.
    expect((await call(curator, 'update_document', { id, add_tags: ['Steuer'] })).structuredContent).toMatchObject({ changed: [] });
    await curator.close();
  });

  it('deletes and uploads with their own permissions', async () => {
    const id = await addDocument('Alt', 'Ein altes Schreiben, das weg kann, mit genug Text für die Erkennung');
    const c = await connect(await listen(), await newKey(['mcp', 'read', 'delete', 'upload']));
    expect((await call(c, 'delete_document', { id })).structuredContent).toMatchObject({ deleted: id, in_trash: true });
    await expect(local().getDocument(SYSTEM_SCOPE, id)).rejects.toThrow();
    const pdf = makePdf([['Neue Rechnung der Stadtwerke mit ausreichend Text für die Texterkennung', 'Betrag 42,00 Euro']]);
    const up = await call(c, 'upload_document', { filename: 'rechnung.pdf', content_base64: Buffer.from(pdf).toString('base64'), title: 'Neue Rechnung', analyse: false });
    expect(up.isError, up.content[0].text).toBeFalsy();
    expect(up.structuredContent).toMatchObject({ status: 'stored', document_id: expect.any(Number) });
    expect((await local().getDocument(SYSTEM_SCOPE, up.structuredContent!.document_id as number)).title).toBe('Neue Rechnung');
    expect((await call(c, 'upload_document', { filename: 'leer.pdf', content_base64: '====' })).isError).toBe(true);
    await c.close();
  });

  it('answers questions from the documents', async () => {
    await addDocument('Stromrechnung', 'Stadtwerke Strom Abrechnung über 89,50 Euro für März 2024', { correspondent: 'Stadtwerke', created: '2024-03-31' });
    h.llm.reply((req) =>
      req.system.startsWith('You prepare searches') ? JSON.stringify({ query: 'Strom Abrechnung', keywords: ['strom'] }) : { content: 'Die Stromrechnung betrug 89,50 Euro [1].' },
    );
    await h.rag.sync();
    const c = await connect(await listen(), await newKey(['mcp', 'chat']));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['ask_documents', 'find_similar_passages']);
    const res = await call(c, 'ask_documents', { question: 'Wie hoch war die Stromrechnung?' });
    expect(res.isError, res.content[0].text).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ answer: 'Die Stromrechnung betrug 89,50 Euro [1].', sources: [expect.objectContaining({ title: 'Stromrechnung', correspondent: 'Stadtwerke' })] });
    await c.close();
  });

  it('refuses what is not for agents and answers in JSON-RPC', async () => {
    const reader = await newKey(['read']);
    const agent = await newKey(['mcp', 'read']);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } } };
    // Without a key, without the MCP permission, with a session: no.
    const anon = await h.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(init) });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await rpc(reader, init)).statusCode).toBe(403);
    const session = await h.inject({ method: 'POST', url: '/mcp', headers: { cookie, 'content-type': 'application/json' }, payload: JSON.stringify(init) });
    expect(session.statusCode).toBe(403);
    // Web pages of other origins (DNS rebinding) – no.
    expect((await rpc(agent, init, { origin: 'http://evil.example' })).statusCode).toBe(403);

    const ok = await rpc(agent, init);
    expect(ok.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'paperless-ai' } } });
    // An unknown version: the newest of the server.
    expect((await rpc(agent, { ...init, params: { ...init.params, protocolVersion: '1999-01-01' } })).json().result.protocolVersion).toBe('2025-11-25');
    // Notifications: 202 without a body.
    const note = await rpc(agent, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.statusCode).toBe(202);
    expect(note.body).toBe('');
    // Errors of JSON-RPC.
    expect((await rpc(agent, { jsonrpc: '2.0', id: 2, method: 'nonsense' })).json().error.code).toBe(-32601);
    const broken = await h.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' }, payload: '{"jsonrpc":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe(-32700);
    expect((await rpc(agent, { jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).statusCode).toBe(400);
    // A batch (protocol 2025-03-26).
    const batch = (await rpc(agent, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])).json();
    expect(batch.map((a: { id: string }) => a.id)).toEqual(['a', 'b']);
    // No server stream, no sessions.
    expect((await h.inject({ method: 'GET', url: '/mcp', headers: { authorization: `Bearer ${agent}` } })).statusCode).toBe(405);
    expect((await h.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: `Bearer ${agent}` } })).statusCode).toBe(405);
  });

  it('keeps to the rate limit of the key', async () => {
    const key = await newKey(['mcp', 'read'], { rateLimit: 2 });
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(key, ping)).statusCode).toBe(200);
    expect((await rpc(key, ping)).statusCode).toBe(200);
    const third = await rpc(key, ping);
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // Also in the rest of the API, and shown with the key.
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(429);
    const keys = (await h.inject({ method: 'GET', url: '/api/me/api-keys', headers: { cookie } })).json() as { rateLimit: number | null }[];
    expect(keys.map((k) => k.rateLimit)).toContain(2);
  });
});

describe('MCP server with Paperless-ngx as the archive', () => {
  it('searches, reads and changes documents there', async () => {
    const ngx = await createHarness();
    try {
      const tag = ngx.paperless.addTag('Rechnung');
      const corr = ngx.paperless.addCorrespondent('Stadtwerke');
      const doc = ngx.paperless.addDocument({ title: 'Stromrechnung', content: 'Stadtwerke Strom Abrechnung März', tags: [tag.id], correspondent: corr.id, created: '2024-03-31' });
      const login = await ngx.login();
      const key = (await ngx.inject({ method: 'POST', url: '/api/me/api-keys', headers: { cookie: login }, payload: { name: 'Agent', scopes: ['mcp', 'read', 'write'] } })).json().key as string;
      await ngx.app.listen({ port: 0, host: '127.0.0.1' });
      const c = await connect(`http://127.0.0.1:${(ngx.app.server.address() as AddressInfo).port}`, key);
      expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('list_libraries');
      const found = (await call(c, 'search_documents', { tags: ['Rechnung'] })).structuredContent!;
      expect(found.documents).toEqual([expect.objectContaining({ id: doc.id, title: 'Stromrechnung', correspondent: 'Stadtwerke', tags: ['Rechnung'] })]);
      expect((await call(c, 'get_document', { id: doc.id })).structuredContent).toMatchObject({ title: 'Stromrechnung', text: expect.stringContaining('Stadtwerke') });
      const changed = await call(c, 'update_document', { id: doc.id, title: 'Stromrechnung März' });
      expect(changed.isError, changed.content[0].text).toBeFalsy();
      expect(ngx.paperless.docs.get(doc.id)?.title).toBe('Stromrechnung März');
      await c.close();
    } finally {
      await ngx.close();
    }
  });
});

describe('stdio bridge', () => {
  it('passes the messages of a local MCP client to the server and back', async () => {
    await addDocument('Stromrechnung', 'Stadtwerke Strom Abrechnung über 89,50 Euro', { tags: ['Rechnung'] });
    const base = await listen();
    const key = await newKey(['mcp', 'read']);
    expect(bridgeOptions(['--url', `${base}/`, '--key', key], {})).toEqual({ url: `${base}/mcp`, key });
    expect(bridgeOptions([], { PAPERLESS_AI_URL: `${base}/mcp`, PAPERLESS_AI_API_KEY: key })).toEqual({ url: `${base}/mcp`, key });

    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    const done = runBridge({ url: `${base}/mcp`, key, input, output, log: () => undefined });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_documents', arguments: { query: 'strom' } } })}\n`);
    input.write('not json\n');
    input.end();
    expect(await done).toBe(0);
    const answers = lines.map((l) => JSON.parse(l) as { id: number | null; result?: { structuredContent?: { total: number }; protocolVersion?: string }; error?: { code: number } });
    expect(answers.find((a) => a.id === 1)?.result?.protocolVersion).toBe('2025-06-18');
    expect(answers.find((a) => a.id === 2)?.result?.structuredContent?.total).toBe(1);
    expect(answers.find((a) => a.id === null)?.error?.code).toBe(-32700);
    expect(answers).toHaveLength(3);
  });

  it('turns HTTP errors into JSON-RPC errors and can be downloaded', async () => {
    const base = await listen();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (b: Buffer) => lines.push(...b.toString().split('\n').filter(Boolean)));
    const done = runBridge({ url: `${base}/mcp`, key: 'pai_wrongkey_xxxxxxxxxxxxxxxxxxxxxxxxxxxx', input, output, log: () => undefined });
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    await done;
    expect(JSON.parse(lines[0])).toMatchObject({ id: 7, error: { message: expect.stringMatching(/401.*API key/) } });
    expect(await runBridge({ url: '', key: '', input: new PassThrough(), output: new PassThrough(), log: () => undefined })).toBe(2);

    const file = await h.inject({ method: 'GET', url: '/mcp/bridge.mjs' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toMatch(/javascript/);
    expect(file.body).toContain('export async function runBridge');
  });
});

describe('finer API key permissions', () => {
  it('needs delete for deleting and metadata for managing labels', async () => {
    const id = await addDocument('Brief', 'Ein Brief mit genug Text für die Erkennung des Inhalts');
    const writer = { authorization: `Bearer ${await newKey(['read', 'write'])}` };
    const deleter = { authorization: `Bearer ${await newKey(['read', 'delete'])}` };
    const curator = { authorization: `Bearer ${await newKey(['read', 'metadata'])}` };
    // Deleting: only with delete (also in bulk and in the API for Paperless-ngx apps).
    expect((await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: writer })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: writer, payload: { ids: [id], action: 'delete' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'DELETE', url: `/ngx/api/documents/${id}/`, headers: writer })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/ngx/api/documents/bulk_edit/', headers: writer, payload: { documents: [id], method: 'delete' } })).statusCode).toBe(403);
    // Changing a document still works with write.
    expect((await h.inject({ method: 'PATCH', url: `/api/documents/${id}`, headers: writer, payload: { title: 'Brief 2' } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: deleter })).statusCode).toBe(200);
    // Labels: only with metadata.
    expect((await h.inject({ method: 'POST', url: '/api/tags', headers: writer, payload: { name: 'Neu' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: writer, payload: { name: 'Neu' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/api/tags', headers: curator, payload: { name: 'Neu' } })).statusCode).toBe(200);
  });
});
