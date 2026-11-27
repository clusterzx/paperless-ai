/**
 * Data isolation between libraries of the built-in archive (docs/standalone/access-control.md §4,
 * §11): a member who reads only one library calls every route – lists, statistics, history,
 * calendar and its feed, Ask your archive, document chat – and must never see anything of the other
 * library, neither in a response nor in a prompt sent to the AI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import { hashPassword, issueSession, SESSION_COOKIE } from '../../src/server/auth.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';

/** Appears only in the documents of the library the member cannot read. */
const MARKER = 'quokka';
let h: Harness;
let admin: string;
let member: string;
let memberKey: Record<string, string>;
let own: number;
let foreign: number;

beforeAll(async () => {
  h = await createHarness({ archive: 'builtin', embedding: 'custom', config: { processing: { functions: { events: true } } } });
  admin = await h.login();
  const local = h.ctx.archive() as LocalBackend;
  const main = local.ensureDefaultLibrary();
  const secret = h.ctx.repos.libraries.create('Secret', h.ctx.repos.users.byUsername('admin')!.id, {});

  h.llm.reply((req) => {
    const text = JSON.stringify(req.body);
    if (text.includes('Kontoauszug')) {
      return analysisJson({
        title: 'Quokka Kontoauszug März',
        correspondent: 'Quokka Bank',
        tags: ['Quokkatag'],
        document_type: 'Quokka Auszug',
        events: [{ title: 'Quokka Frist', date: '2030-05-01', time: null, kind: 'deadline' }],
      });
    }
    return analysisJson({ title: 'Wasserrechnung März', correspondent: 'Stadtwerke', tags: ['Rechnung'], events: [{ title: 'Zahlung Wasser', date: '2030-04-01', time: null, kind: 'due' }] });
  });
  own = (await local.ingest(SYSTEM_SCOPE, { data: makePdf([['Wasserrechnung Stadtwerke', 'Betrag 42 EUR']]), filename: 'wasser.pdf' }, 'api', { libraryId: main })).documentId!;
  foreign = (await local.ingest(SYSTEM_SCOPE, { data: makePdf([['Kontoauszug Quokka Bank', 'Saldo 1234 EUR Quokka']]), filename: 'quokka.pdf' }, 'api', { libraryId: secret })).documentId!;
  await h.engine.drain();
  await h.rag.sync();

  const memberId = h.ctx.repos.users.create('anna', await hashPassword('member password 1'), 'member');
  h.ctx.repos.libraries.setMember(main, 'user', memberId, 'viewer');
  member = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(memberId)!)}`;
  memberKey = { 'x-api-key': h.ctx.repos.apiKeys.create(memberId, { name: 'all', scopes: ['read', 'write', 'chat', 'upload'] }).key };
  h.llm.requests.length = 0;
});
afterAll(() => h.close());

const leaks = (body: string) => body.toLowerCase().includes(MARKER);

describe('library isolation', () => {
  it('the marker is there for the admin (the checks below are not vacuous)', async () => {
    const list = await h.inject({ method: 'GET', url: '/api/documents?limit=50', headers: { cookie: admin } });
    expect(leaks(list.body)).toBe(true);
    const search = await h.inject({ method: 'POST', url: '/api/rag/search', headers: { cookie: admin }, payload: { query: 'Kontoauszug Saldo' } });
    expect(leaks(search.body)).toBe(true);
    expect((await h.inject({ method: 'GET', url: '/api/history', headers: { cookie: admin } })).body.toLowerCase()).toContain(MARKER);
    expect((await h.inject({ method: 'GET', url: '/api/calendar', headers: { cookie: admin } })).body.toLowerCase()).toContain(MARKER);
  });

  it('no GET route shows the member anything of the other library', async () => {
    const skip = new Set(['/api/logs/stream', '/api/events']);
    const wrong: string[] = [];
    for (const r of h.app.registeredRoutes) {
      if (r.method !== 'GET' || skip.has(r.url) || r.auth === 'public' || r.auth === 'setup') continue;
      if (!r.url.startsWith('/api/') && !r.url.startsWith('/chat/')) continue;
      for (const headers of [{ cookie: member }, memberKey]) {
        // Ids in paths point at the foreign document.
        const url = r.url.replace(/:id\b/g, String(foreign)).replace(/:[a-zA-Z]+/g, '1');
        const res = await h.inject({ method: 'GET', url, headers });
        if (leaks(res.body)) wrong.push(`GET ${url} (${'cookie' in headers ? 'session' : 'API key'}) → ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the member sees their own documents, but never the foreign one by id', async () => {
    const list = await h.inject({ method: 'GET', url: '/api/documents?limit=50', headers: { cookie: member } });
    expect(list.json().results.map((d: { id: number }) => d.id)).toEqual([own]);
    for (const url of [`/api/documents/${foreign}`, `/api/documents/${foreign}/file`, `/api/documents/${foreign}/versions`, `/api/documents/${foreign}/activity`, `/chat/init/${foreign}`]) {
      expect((await h.inject({ method: 'GET', url, headers: { cookie: member } })).statusCode, url).toBe(404);
    }
    const chat = await h.inject({ method: 'POST', url: `/api/chat/document/${foreign}`, headers: { cookie: member }, payload: { message: 'Worum geht es?' } });
    expect(leaks(chat.body)).toBe(false);
  });

  it('Ask your archive searches only the readable library – in results and in the prompts', async () => {
    h.llm.requests.length = 0;
    h.llm.reply('{"query": "Kontoauszug", "keywords": ["Kontoauszug", "Saldo", "Bank"]}');
    const search = await h.inject({ method: 'POST', url: '/api/rag/search', headers: { cookie: member }, payload: { query: 'Kontoauszug Saldo Bank' } });
    expect(search.statusCode).toBe(200);
    expect(leaks(search.body)).toBe(false);

    h.llm.reply('Keine passenden Dokumente.');
    const chat = await h.inject({ method: 'POST', url: '/api/rag/chat', headers: { cookie: member }, payload: { question: 'Welche Kontoauszüge und Salden gibt es?' } });
    expect(chat.statusCode).toBe(200);
    expect(leaks(chat.body)).toBe(false);
    const ask = await h.inject({ method: 'POST', url: '/api/rag/ask', headers: memberKey, payload: { question: 'Wie hoch ist der Saldo auf dem Kontoauszug?' } });
    expect(leaks(ask.body)).toBe(false);

    const prompts = h.llm.chatRequests().map((r) => JSON.stringify(r.body));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.filter(leaks)).toEqual([]);
  });

  it('the calendar feed of the member contains only dates of readable documents', async () => {
    const feed = (await h.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie: member } })).json() as { path: string };
    const ics = await h.inject({ method: 'GET', url: feed.path });
    expect(ics.statusCode).toBe(200);
    expect(ics.body).toContain('Zahlung Wasser');
    expect(leaks(ics.body)).toBe(false);
  });

  it('the member cannot act on the foreign document', async () => {
    const event = h.ctx.repos.calendar.list({ dismissed: true }).find((e) => e.document_id === foreign)!;
    for (const [method, url, payload] of [
      ['POST', `/api/calendar/${event.id}/dismiss`, {}],
      ['PATCH', `/api/documents/${foreign}`, { title: 'x' }],
      ['DELETE', `/api/documents/${foreign}`, undefined],
      ['POST', `/api/documents/${foreign}/versions/1/activate`, {}],
      ['POST', '/api/history/revert', { documentIds: [foreign] }],
    ] as const) {
      const res = await h.inject({ method, url, headers: { cookie: member }, ...(payload ? { payload } : {}) });
      const ok = res.statusCode < 300 && !(res.json() as { results?: { ok: boolean }[] }).results?.every((x) => !x.ok);
      expect(ok, `${method} ${url} → ${res.statusCode} ${res.body}`).toBe(false);
    }
    expect((await h.ctx.backend().getDocument(foreign)).title).toBe('Quokka Kontoauszug März');
  });

  it('the member cannot have the foreign document analysed (the analysis saves with the system scope)', async () => {
    const memberId = h.ctx.repos.users.byUsername('anna')!.id;
    const webhookKey = h.ctx.repos.apiKeys.create(memberId, { name: 'hook', scopes: ['webhook'] }).key;
    h.llm.reply(analysisJson({ title: 'PWNED' }));
    const queued = await h.inject({ method: 'POST', url: '/api/processing/documents', headers: { cookie: member }, payload: { ids: [foreign], prompt: 'Title: PWNED' } });
    expect(queued.json()).toMatchObject({ queued: 0, refused: 1 });
    const hook = await h.inject({ method: 'POST', url: '/api/webhook/document', headers: { 'x-api-key': webhookKey }, payload: { document_id: foreign } });
    expect(hook.statusCode).toBe(404);
    // Reading is not enough to start an analysis either (it runs on the AI of the instance).
    const viewer = await h.inject({ method: 'POST', url: `/api/documents/${own}/analyze`, headers: { cookie: member }, payload: {} });
    expect(viewer.statusCode).toBe(403);
    await h.engine.drain();
    expect((await h.ctx.backend().getDocument(foreign)).title).toBe('Quokka Kontoauszug März');
  });

  it('the member cannot share a saved view into the other library', async () => {
    const secret = h.ctx.repos.libraries.list().find((l) => l.name === 'Secret')!.id;
    expect((await h.inject({ method: 'POST', url: '/api/saved-views', headers: { cookie: member }, payload: { name: 'Mine', filter: {}, libraryId: secret } })).statusCode).toBe(404);
    const view = (await h.inject({ method: 'POST', url: '/api/saved-views', headers: { cookie: member }, payload: { name: 'Mine', filter: {} } })).json() as { id: number };
    const moved = await h.inject({ method: 'PATCH', url: `/api/saved-views/${view.id}`, headers: { cookie: member }, payload: { libraryId: secret } });
    expect(moved.statusCode).toBe(404);
    expect(h.ctx.repos.savedViews.get(view.id)?.library_id).toBeNull();
  });
});
