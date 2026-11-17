import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarResponse } from '../../src/shared/api.js';
import { analysisJson, createHarness, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import type { ChatRequestInfo } from '../helpers/mockLlm.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const ON: HarnessOptions = { config: { processing: { functions: { events: true } } } };

async function harness(opts: HarnessOptions = ON) {
  h = await createHarness(opts);
  const cookie = await h.login();
  const get = async (url = '/api/calendar') => (await h!.inject({ method: 'GET', url, headers: { cookie } })).json() as CalendarResponse;
  const post = (url: string, payload?: object) => h!.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const process = async () => {
    await h!.inject({ method: 'POST', url: '/api/processing/scan', headers: h!.apiKeyHeaders() });
    await h!.engine.drain(10_000);
  };
  return { hh: h, cookie, get, post, process };
}

const INVOICE = 'City Power GmbH\nInvoice no. 2024-77\nTotal 76,90 EUR\nPayable until 30.04.2099.';
const events = [
  { title: 'Pay invoice 2024-77 to City Power', date: '2099-04-30', time: '', kind: 'due' },
  { title: 'Meter reading appointment', date: '2099-05-02', time: '09:30', kind: 'appointment' },
];

describe('calendar', () => {
  it('stores the dates found while processing, and asks for them only when switched on', async () => {
    const { hh, get, process } = await harness();
    hh.paperless.addDocument({ id: 5, title: 'scan.pdf', content: INVOICE });
    hh.llm.reply(analysisJson({ title: 'Invoice 2024-77', events }));
    await process();

    const schema = (hh.llm.chatRequests()[0].body!.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema;
    expect(schema.required).toContain('events');
    const cal = await get();
    expect(cal).toMatchObject({ enabled: true, scannedDocuments: 1 });
    expect(cal.events).toEqual([
      { id: expect.any(Number), documentId: 5, documentTitle: 'Invoice 2024-77', url: `${hh.paperless.url}/documents/5/details`, title: 'Pay invoice 2024-77 to City Power', date: '2099-04-30', time: null, kind: 'due', dismissed: false },
      expect.objectContaining({ title: 'Meter reading appointment', time: '09:30', kind: 'appointment' }),
    ]);
    expect((await hh.inject({ method: 'GET', url: '/api/session', headers: hh.apiKeyHeaders() })).json().features.calendar).toBe(true);
  });

  it('is off by default: no dates are asked for or stored', async () => {
    const { hh, get, post, process } = await harness({});
    hh.paperless.addDocument({ id: 5, content: INVOICE });
    hh.llm.reply(analysisJson({ events }));
    await process();
    const body = hh.llm.chatRequests()[0].body!;
    expect(JSON.stringify(body)).not.toContain('"events"');
    expect(await get()).toMatchObject({ enabled: false, events: [], scannedDocuments: 0 });
    expect((await post('/api/calendar/scan', { months: 0 })).statusCode).toBe(409);
  });

  it('keeps dismissed dates hidden when a document is analysed again', async () => {
    const { hh, get, post, process } = await harness();
    hh.paperless.addDocument({ id: 5, content: INVOICE });
    hh.llm.reply(analysisJson({ events }));
    await process();
    const [due] = (await get()).events;
    expect((await post(`/api/calendar/${due.id}/dismiss`)).json()).toEqual({ ok: true });
    expect((await get()).events.map((e) => e.kind)).toEqual(['appointment']);

    // analysed again (e.g. retry): the dismissed date does not come back, a new one is added
    hh.llm.reply(analysisJson({ events: [...events, { title: 'Contract renewal', date: '2099-12-31', time: '', kind: 'expiry' }] }));
    hh.engine.enqueue(5, { source: 'manual', force: true });
    await hh.engine.drain(10_000);
    expect((await get()).events.map((e) => e.title)).toEqual(['Meter reading appointment', 'Contract renewal']);
    const all = await get('/api/calendar?dismissed=true');
    expect(all.events.filter((e) => e.dismissed).map((e) => e.id)).toEqual([due.id]);
    expect((await post(`/api/calendar/${due.id}/restore`)).statusCode).toBe(200);
    expect((await get()).events).toHaveLength(3);
    expect((await get('/api/calendar?from=2099-05-01&to=2099-06-30')).events.map((e) => e.title)).toEqual(['Meter reading appointment']);
    expect((await post('/api/calendar/9999/dismiss')).statusCode).toBe(404);
  });

  it('searches earlier documents for dates without changing anything in Paperless', async () => {
    const { hh, get, post } = await harness();
    hh.paperless.addDocument({ id: 1, title: 'Old invoice', content: INVOICE, created: new Date().toISOString().slice(0, 10) });
    hh.paperless.addDocument({ id: 2, title: 'Empty', content: '  ', created: new Date().toISOString().slice(0, 10) });
    hh.paperless.addDocument({ id: 3, title: 'Very old letter', content: 'A letter from long ago with enough text', created: '2015-01-01' });
    hh.llm.reply((req: ChatRequestInfo) => (req.system.startsWith('You read documents') ? JSON.stringify({ language: 'en', events: events.slice(0, 1) }) : 'unexpected'));

    const started = await post('/api/calendar/scan', { months: 12 });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await get()).scan.running).toBe(false), { timeout: 10_000 });
    const cal = await get();
    expect(cal.scan).toMatchObject({ done: 2, total: 2, found: 1, failed: 0, error: null });
    expect(cal.events.map((e) => [e.documentId, e.title])).toEqual([[1, 'Pay invoice 2024-77 to City Power']]);
    expect(cal.scannedDocuments).toBe(2);
    // only the dates were asked for, and nothing was written to Paperless
    const [req] = hh.llm.chatRequests();
    const schema = (req.body!.response_format as { json_schema: { schema: { properties: Record<string, unknown> } } }).json_schema.schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['events', 'language']);
    expect(hh.paperless.patches()).toHaveLength(0);
    expect(hh.ctx.repos.usage.stats().byFeature).toEqual(expect.arrayContaining([expect.objectContaining({ feature: 'calendar' })]));

    // a second scan skips documents searched already; "all" includes the old one
    await post('/api/calendar/scan', { months: 0 });
    await vi.waitFor(async () => expect((await get()).scan.running).toBe(false), { timeout: 10_000 });
    expect((await get()).scan).toMatchObject({ total: 1, done: 1 });
  });

  it('serves a private iCal feed – the link is the key', async () => {
    const { hh, cookie, process } = await harness();
    hh.paperless.addDocument({ id: 5, content: INVOICE });
    hh.llm.reply(analysisJson({ title: 'Invoice 2024-77', events }));
    await process();

    const feedRes = await hh.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie } });
    const { path } = feedRes.json() as { path: string };
    expect(path).toMatch(/^\/api\/calendar\/feed\/[\w-]{32}\.ics$/);
    // the same link every time (calendar apps keep it)
    expect((await hh.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie } })).json().path).toBe(path);
    // API keys may not read the secret link
    expect((await hh.inject({ method: 'GET', url: '/api/calendar/feed', headers: hh.apiKeyHeaders() })).statusCode).toBe(403);

    const ics = await hh.inject({ method: 'GET', url: path });
    expect(ics.statusCode).toBe(200);
    expect(ics.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(ics.body).toContain('SUMMARY:Pay invoice 2024-77 to City Power');
    expect(ics.body).toContain('DTSTART:20990502T093000');
    expect((await hh.inject({ method: 'GET', url: '/api/calendar/feed/wrong-token.ics' })).statusCode).toBe(404);

    const renewed = (await hh.inject({ method: 'POST', url: '/api/calendar/feed/reset', headers: { cookie } })).json().path as string;
    expect(renewed).not.toBe(path);
    expect((await hh.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await hh.inject({ method: 'GET', url: renewed })).statusCode).toBe(200);
  });
});
