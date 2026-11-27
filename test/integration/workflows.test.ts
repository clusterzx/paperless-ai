/**
 * Workflows (docs/standalone/workflows.md §11): triggers → runs → change log, AI conditions and
 * their cache, loop protection, crash recovery, webhook retries, dry runs, schedules and dates,
 * manual runs and undo, companion mode, permissions.
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, waitFor, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { hashPassword, issueSession, SESSION_COOKIE } from '../../src/server/auth.js';
import { retryDelays } from '../../src/server/workflows/notify.js';
import type { DryRunResult, Workflow, WorkflowDefinition, WorkflowRun } from '../../src/shared/workflows.js';
import type { DocumentDetail } from '../../src/shared/api.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const local = () => h.ctx.archive() as LocalBackend;
let n = 0;
async function ingest(lines: string[], hints: Record<string, unknown> = {}): Promise<number> {
  const r = await local().ingest(SYSTEM_SCOPE, { data: makePdf([[...lines, `Nr ${++n}`]]), filename: `scan-${n}.pdf` }, 'upload', { skipAnalysis: true, ...hints });
  return r.documentId!;
}
const def = (d: Partial<WorkflowDefinition> & Pick<WorkflowDefinition, 'trigger' | 'actions'>): WorkflowDefinition => ({
  name: 'Test',
  enabled: true,
  libraryId: null,
  conditions: { op: 'all', items: [] },
  stopAfterMatch: false,
  allowedLibraries: [],
  ...d,
});

async function create(cookie: string, d: WorkflowDefinition): Promise<Workflow> {
  const res = await h.inject({ method: 'POST', url: '/api/workflows', headers: { cookie }, payload: d });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Workflow;
}

async function settle() {
  await h.engine.drain();
  await h.workflows.drain();
  await h.engine.drain();
  await h.workflows.drain();
}

const doc = async (id: number, cookie: string) => (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;

describe('workflows in the built-in archive', () => {
  it('acts on new documents: conditions, field changes in one write, notifications, run log and change log', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const meta = h.ctx.metadata(local().ensureDefaultLibrary());
    await meta.resolveCustomField('Betrag', true, 'monetary', 'EUR');
    const admin = h.ctx.repos.users.byUsername('admin')!.id;
    const wf = await create(
      cookie,
      def({
        name: 'Rechnungen',
        trigger: { type: 'document.added', channels: ['upload'] },
        conditions: { op: 'all', items: [{ type: 'text', contains: 'Rechnung' }, { op: 'any', items: [{ type: 'filename', pattern: 'scan-*.pdf' }, { type: 'page_count', min: 5 }] }] },
        actions: [
          { type: 'add_tags', names: ['Finanzen', 'Eingang'] },
          { type: 'set_title', template: 'Rechnung vom {added}' },
          { type: 'set_custom_field', name: 'Betrag', value: '84,20' },
          { type: 'assign_asn' },
          { type: 'notify_inapp', users: [admin], groups: [], title: 'Neue Rechnung: {title}', body: 'ASN {asn}' },
        ],
      }),
    );
    const invoice = await ingest(['Stadtwerke Rechnung', 'Betrag 84,20 EUR']);
    const letter = await ingest(['Ein Brief ohne das Wort']);
    await settle();

    const d = await doc(invoice, cookie);
    await meta.snapshot(true);
    expect(d.tags.map((t) => meta.tagName(t)).sort()).toEqual(['Eingang', 'Finanzen']);
    expect(d.title).toBe(`Rechnung vom ${new Date().toISOString().slice(0, 10)}`);
    expect(d.archive_serial_number).toBe(1);
    expect(d.custom_fields).toEqual([{ field: meta.customFieldByName('Betrag')!.id, value: 'EUR84.20' }]);
    expect((await doc(letter, cookie)).tags).toEqual([]);

    // One change log entry for all field changes, attributed to the run.
    const runs = (await h.inject({ method: 'GET', url: `/api/workflows/runs?workflowId=${wf.id}`, headers: { cookie } })).json() as WorkflowRun[];
    expect(runs.map((r) => [r.documentId, r.status]).sort()).toEqual([
      [invoice, 'succeeded'],
      [letter, 'not_matched'],
    ]);
    const run = runs.find((r) => r.documentId === invoice)!;
    const events = h.ctx.db.prepare("SELECT kind, actor_type, actor_id, ref FROM lib_document_events WHERE document_id = ? AND kind = 'updated'").all(invoice);
    expect(events).toEqual([{ kind: 'updated', actor_type: 'workflow', actor_id: wf.id, ref: `run:${run.id}` }]);
    const detail = (await h.inject({ method: 'GET', url: `/api/workflows/runs/${run.id}`, headers: { cookie } })).json() as WorkflowRun;
    expect(detail.steps!.filter((s) => s.kind === 'condition').map((s) => s.status)).toEqual(['matched', 'matched']);
    expect(detail.steps!.filter((s) => s.kind === 'action').map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    // In-app notification with the values after the changes.
    expect(h.ctx.repos.notifications.list(admin)[0]).toMatchObject({ title: `Neue Rechnung: Rechnung vom ${new Date().toISOString().slice(0, 10)}`, body: 'ASN 1', link: `/documents/${invoice}` });
    // The document's activity shows the run.
    const activity = (await h.inject({ method: 'GET', url: `/api/documents/${invoice}/activity`, headers: { cookie } })).json() as { kind: string; title: string }[];
    expect(activity.find((a) => a.kind === 'workflow')?.title).toBe('Workflow “Rechnungen” ran');

    // The whole run is undone together.
    const undo = await h.inject({ method: 'POST', url: `/api/workflows/runs/${run.id}/undo`, headers: { cookie }, payload: {} });
    expect(undo.statusCode, undo.body).toBe(200);
    const back = await doc(invoice, cookie);
    expect(back.tags).toEqual([]);
    expect(back.archive_serial_number).toBeNull();
  });

  it('skips the analysis of new documents and asks the AI only when the rest matched (cached)', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    await create(cookie, def({ name: 'Store only', trigger: { type: 'document.added' }, conditions: { op: 'all', items: [{ type: 'text', contains: 'Werbung' }] }, actions: [{ type: 'skip_analysis' }] }));
    h.llm.reply(analysisJson({ title: 'Analysiert' }));
    const ad = (await local().ingest(SYSTEM_SCOPE, { data: makePdf([['Werbung für Möbel, sehr günstig']]), filename: 'ad.pdf' }, 'upload', {})).documentId!;
    const real = (await local().ingest(SYSTEM_SCOPE, { data: makePdf([['Kündigung des Mietvertrags zum 31.12.']]), filename: 'k.pdf' }, 'upload', {})).documentId!;
    await settle();
    expect(h.ctx.repos.documents.get(ad)).toMatchObject({ status: 'skipped', reason: 'Not analysed (workflow “Store only”)' });
    expect(h.ctx.repos.documents.get(real)?.status).toBe('processed');

    // AI question: only asked when the cheap condition matched; the answer is cached per version.
    h.llm.clearRequests();
    h.llm.reply((req) => (req.system.includes('yes/no question') ? '{"answer": true, "reason": "It terminates a contract."}' : analysisJson({})));
    const wf = def({
      trigger: { type: 'manual' },
      conditions: { op: 'all', items: [{ type: 'ai_question', question: 'Is this a termination of a contract?', expect: true }, { type: 'text', contains: 'Kündigung' }] },
      actions: [{ type: 'add_tags', names: ['Kündigung'] }],
    });
    const dry = async (id: number) => (await h.inject({ method: 'POST', url: '/api/workflows/dry-run', headers: { cookie }, payload: { documentId: id, workflow: wf } })).json() as DryRunResult;
    const first = await dry(real);
    expect(first.matched).toBe(true);
    expect(first.steps.map((s) => s.name)).toEqual(['Text contains “Kündigung”', 'AI: Is this a termination of a contract? (expected: yes)', 'Add tags Kündigung']);
    expect(first.steps[1].details).toMatchObject({ answer: true, reason: 'It terminates a contract.', cached: false });
    expect(first.changes).toEqual([{ field: 'tags', before: [], after: ['Kündigung'] }]);
    expect(first.tokens).toBeGreaterThan(0);
    const second = await dry(real);
    expect(second.steps[1].details).toMatchObject({ cached: true });
    expect(h.llm.chatRequests()).toHaveLength(1);
    // Not asked at all when the text does not match.
    expect((await dry(ad)).steps.map((s) => s.status)).toEqual(['not_matched']);
    expect(h.llm.chatRequests()).toHaveLength(1);
    // The dry run wrote nothing.
    expect((await doc(real, cookie)).tags).toEqual([]);
  });

  it('stops loops: own changes, chains deeper than 3 and too many runs per hour', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    // A reacts to title changes by adding a tag; B reacts to tag changes by changing the title.
    await create(cookie, def({ name: 'A', trigger: { type: 'document.updated', fields: ['title'] }, actions: [{ type: 'add_tags', names: ['a'] }, { type: 'set_title', template: '{title}+' }] }));
    await create(cookie, def({ name: 'B', trigger: { type: 'document.updated', fields: ['tags'] }, actions: [{ type: 'remove_tags', names: ['a'] }, { type: 'set_title', template: '{title}b' }] }));
    const id = await ingest(['Loop test']);
    await settle();
    await h.inject({ method: 'PATCH', url: `/api/documents/${id}`, headers: { cookie }, payload: { title: 'Start' } });
    await settle();
    const runs = h.ctx.repos.workflows.runs({ documentId: id });
    const skipped = runs.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].error).toMatch(/deeper than 3/);
    // A did not trigger itself (its own title change), and the chain ended.
    expect(runs.filter((r) => r.status === 'succeeded').length).toBeLessThanOrEqual(3);
    expect((await doc(id, cookie)).title.length).toBeLessThan(12);
  });

  it('continues runs interrupted by a crash, retries webhooks and signs them', async () => {
    retryDelays.value = [10, 10, 10];
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    let calls = 0;
    const bodies: { body: string; signature: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        calls++;
        bodies.push({ body, signature: req.headers['x-paperless-ai-signature'] as string | undefined });
        res.writeHead(calls === 1 ? 503 : 200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      const wf = await create(cookie, def({ name: 'Hook', trigger: { type: 'manual' }, actions: [{ type: 'notify_webhook', url, preset: 'generic', secret: 's3cret' }] }));
      const id = await ingest(['Webhook test']);
      // A run left "running" by a crash goes back to the queue on start.
      const runId = h.ctx.repos.workflows.enqueue({ workflowId: wf.id, revision: 1, documentId: id, trigger: 'manual', status: 'queued' })!;
      h.ctx.db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(runId);
      await h.workflows.stop();
      h.workflows.start();
      await settle();
      expect(h.ctx.repos.workflows.run(runId)?.status).toBe('succeeded');
      expect(calls).toBe(2);
      const step = h.ctx.repos.workflows.steps(runId).find((s) => s.kind === 'action')!;
      expect(step.details).toMatchObject({ status: 200, attempts: 2 });
      const { body, signature } = bodies[1];
      expect(signature).toBe(`sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`);
      expect(JSON.parse(body)).toMatchObject({ workflow: { id: wf.id, name: 'Hook' }, document: { documentId: id } });
    } finally {
      server.close();
    }
  });

  it('runs on a schedule and on dates – once per document and day', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const due = await ingest(['Vertrag'], { created: '2030-01-10' });
    const other = await ingest(['Anderes'], { created: '2030-03-01' });
    const reminder = await create(cookie, def({ name: 'Reminder', trigger: { type: 'date.reached', source: 'created', offsetDays: 30 }, actions: [{ type: 'add_tags', names: ['Frist'] }] }));
    expect(await h.workflows.checkDates('2030-02-09')).toBe(1);
    expect(await h.workflows.checkDates('2030-02-09')).toBe(0);
    await settle();
    const meta = h.ctx.metadata(local().ensureDefaultLibrary());
    await meta.snapshot(true);
    expect((await doc(due, cookie)).tags.map((t) => meta.tagName(t))).toEqual(['Frist']);
    expect((await doc(other, cookie)).tags).toEqual([]);
    expect(h.ctx.repos.workflows.runs({ workflowId: reminder.id })).toHaveLength(1);

    const weekly = await create(cookie, def({ name: 'Weekly', trigger: { type: 'schedule', cron: '0 6 * * 1', tags: ['Frist'] }, actions: [{ type: 'set_custom_field', name: 'Missing', value: 'x' }] }));
    const ids = await h.workflows.fireSchedule(weekly.id, new Date('2030-02-11T06:00:00Z'));
    expect(ids).toHaveLength(1);
    expect(await h.workflows.fireSchedule(weekly.id, new Date('2030-02-11T06:00:00Z'))).toHaveLength(0);
    await settle();
    // A failing action fails the run with the reason.
    expect(h.ctx.repos.workflows.run(ids[0])).toMatchObject({ status: 'failed', error: 'The custom field “Missing” does not exist' });
  });

  it('lets owners manage their library workflows and suspends them when the owner leaves', async () => {
    h = await createHarness({ archive: 'builtin' });
    const admin = await h.login();
    const lib = local().ensureDefaultLibrary();
    const userId = h.ctx.repos.users.create('olga', await hashPassword('olga password 1'), 'member');
    h.ctx.repos.libraries.setMember(lib, 'user', userId, 'owner');
    const olga = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(userId)!)}`;
    const wfBody = def({ name: 'Olga', libraryId: lib, trigger: { type: 'manual' }, actions: [{ type: 'add_tags', names: ['Olga'] }] });
    expect((await h.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: olga }, payload: { ...wfBody, libraryId: null } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: olga }, payload: { ...wfBody, actions: [{ type: 'notify_webhook', url: 'http://10.0.0.1/', preset: 'generic' }] } })).statusCode).toBe(403);
    const wf = (await h.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: olga }, payload: wfBody })).json() as Workflow;
    expect(wf.libraryId).toBe(lib);

    const id = await ingest(['Owner test'], { libraryId: lib });
    const run = await h.inject({ method: 'POST', url: `/api/workflows/${wf.id}/run`, headers: { cookie: olga }, payload: { documentIds: [id] } });
    expect(run.json().queued).toHaveLength(1);
    await settle();
    expect(h.ctx.repos.workflows.runs({ workflowId: wf.id })[0].status).toBe('succeeded');

    // Olga is a viewer now: her workflow does not act with rights nobody holds.
    h.ctx.repos.libraries.setMember(lib, 'user', userId, 'viewer');
    await h.inject({ method: 'POST', url: `/api/workflows/${wf.id}/run`, headers: { cookie: admin }, payload: { documentIds: [id] } });
    await settle();
    expect(h.ctx.repos.workflows.runs({ workflowId: wf.id })[0]).toMatchObject({ status: 'skipped' });
    expect(h.ctx.repos.workflows.get(wf.id)?.suspendedReason).toMatch(/no longer an owner/);
  });

  it('shows webhook credentials only to those who can change the workflow; others test the saved version', async () => {
    h = await createHarness({ archive: 'builtin' });
    const admin = await h.login();
    const lib = local().ensureDefaultLibrary();
    const userId = h.ctx.repos.users.create('vera', await hashPassword('vera password 1'), 'member');
    h.ctx.repos.libraries.setMember(lib, 'user', userId, 'viewer');
    const vera = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(userId)!)}`;
    const wf = await create(
      admin,
      def({ name: 'Hook', trigger: { type: 'manual' }, actions: [{ type: 'notify_webhook', url: 'https://ntfy.example/secret-topic?auth=abc', preset: 'ntfy', secret: 'hush' }] }),
    );

    const mine = (await h.inject({ method: 'GET', url: `/api/workflows/${wf.id}`, headers: { cookie: admin } })).json() as Workflow;
    expect(mine.actions[0]).toMatchObject({ url: 'https://ntfy.example/secret-topic?auth=abc', secret: 'hush' });
    const seen = (await h.inject({ method: 'GET', url: `/api/workflows/${wf.id}`, headers: { cookie: vera } })).json() as Workflow;
    expect(seen.actions[0]).toEqual({ type: 'notify_webhook', preset: 'ntfy', url: 'https://ntfy.example/…', secret: '••••••' });
    const list = (await h.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: vera } })).json() as Workflow[];
    expect(JSON.stringify(list)).not.toMatch(/secret-topic|hush|auth=abc/);

    const id = await ingest(['Hook test'], { libraryId: lib });
    const unsaved = await h.inject({ method: 'POST', url: '/api/workflows/dry-run', headers: { cookie: vera }, payload: { documentId: id, workflow: def({ trigger: { type: 'manual' }, actions: [] }) } });
    expect(unsaved.statusCode).toBe(403);
    const saved = await h.inject({ method: 'POST', url: '/api/workflows/dry-run', headers: { cookie: vera }, payload: { documentId: id, workflowId: wf.id } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((saved.json() as DryRunResult).matched).toBe(true);
  });
});

describe('workflows with Paperless-ngx', () => {
  it('react to the AI analysis and write through the Paperless API, with history and undo', async () => {
    h = await createHarness();
    const cookie = await h.login();
    h.paperless.addTag('Rechnung', 5);
    h.paperless.addDocument({ id: 1, content: 'Stromrechnung der Stadtwerke über 84,20 EUR.' });
    await create(
      cookie,
      def({
        name: 'Nach der Analyse',
        trigger: { type: 'document.processed' },
        conditions: { op: 'all', items: [{ type: 'tags', mode: 'any', names: ['Rechnung'] }] },
        actions: [{ type: 'add_tags', names: ['Zu bezahlen'] }],
      }),
    );
    h.llm.reply(analysisJson({ title: 'Stromrechnung', tags: ['Rechnung'] }));
    await h.inject({ method: 'POST', url: '/api/processing/scan', headers: h.apiKeyHeaders() });
    await settle();
    await waitFor(() => (h.paperless.docs.get(1)?.tags.length ?? 0) === 2);
    const names = h.paperless.docs.get(1)!.tags.map((t) => h.paperless.tags.get(t)!.name).sort();
    expect(names).toEqual(['Rechnung', 'Zu bezahlen']);
    const history = h.ctx.repos.history.list({}).items;
    expect(history.map((i) => i.source).sort()).toEqual(['scan', 'workflow']);
    // move_to_library and version triggers need the built-in archive.
    const bad = await h.inject({ method: 'POST', url: '/api/workflows', headers: { cookie }, payload: def({ trigger: { type: 'document.version_added' }, actions: [] }) });
    expect(bad.statusCode).toBe(400);
  });
});
