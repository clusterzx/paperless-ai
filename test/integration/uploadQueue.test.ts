/**
 * Uploads with `background=true`: the server answers as soon as it has kept a file and stores the
 * files in the background – a slow file (an Office document being converted) holds up neither the
 * sending of the others nor the storing of PDFs; failed files stay retryable.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UploadResult } from '../../src/shared/api.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import type { IntakeEvent } from '../../src/server/events.js';
import { createHarness, waitFor, type Harness } from '../helpers/appHarness.js';
import { FakeOfficeEngine, makeDocx } from '../helpers/office.js';
import { makePdf } from '../helpers/pdf.js';

let h: Harness;
let cookie: string;
let fake: FakeOfficeEngine;
const events: IntakeEvent[] = [];

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
  fake = new FakeOfficeEngine();
  local().office.engineFactory = () => fake;
  h.ctx.config.update({ archive: { builtin: { office: { enabled: true } } } });
  events.length = 0;
  h.ctx.events.onIntake((e) => events.push(e));
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;

async function upload(name: string, data: Buffer, background = true): Promise<UploadResult> {
  const boundary = 'QBOUNDARY';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="skipAnalysis"\r\n\r\ntrue\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.inject({
    method: 'POST',
    url: `/api/documents/upload${background ? '?background=true' : ''}`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: UploadResult[] }).results[0];
}

const intake = async (ids: number[]) =>
  (await h.inject({ method: 'GET', url: `/api/intake?ids=${ids.join(',')}`, headers: { cookie } })).json() as {
    id: number;
    status: string;
    documentId: number | null;
    error: string | null;
  }[];

describe('background uploads', () => {
  it('answers at once and stores in the background – a slow conversion holds up nothing else', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    fake.behave = async () => {
      await gate; // LibreOffice is still starting
      return makePdf([['Mietvertrag']]);
    };
    const docx = await upload('vertrag.docx', makeDocx(['Mietvertrag']));
    expect(docx).toMatchObject({ status: 'queued', intakeId: expect.any(Number) });
    expect(docx.documentId).toBeUndefined();

    // Many files after it: all taken right away …
    const pdfs: UploadResult[] = [];
    for (let i = 1; i <= 30; i++) pdfs.push(await upload(`scan-${i}.pdf`, makePdf([[`Rechnung Nummer ${i}`]])));
    expect(pdfs.every((r) => r.status === 'queued')).toBe(true);
    const refused = await upload('daten.json', Buffer.from('{"a": 1}'));
    expect(refused.status).toBe('queued');

    // … and stored while the Office document still waits for LibreOffice.
    const ids = pdfs.map((r) => r.intakeId!);
    await waitFor(
      async () =>
        (await intake(ids)).every((r) => r.status === 'stored') && (await intake([refused.intakeId!]))[0].status !== 'pending',
      15_000,
    );
    expect((await intake([docx.intakeId!]))[0].status).toBe('pending');
    const [json] = await intake([refused.intakeId!]);
    expect(json).toMatchObject({ status: 'rejected', error: expect.stringMatching(/\.json files are not supported/) });
    expect(events.find((e) => e.intakeId === refused.intakeId && e.status === 'rejected')?.reason).toMatch(
      /\.json files are not supported/,
    );
    // In the order they came.
    const docIds = (await intake(ids)).sort((a, b) => a.id - b.id).map((r) => r.documentId!);
    expect(docIds).toEqual([...docIds].sort((a, b) => a - b));

    open();
    await waitFor(async () => (await intake([docx.intakeId!]))[0].status === 'stored', 10_000);
    expect(events.filter((e) => e.status === 'stored')).toHaveLength(31);
  });

  it('keeps the file of a failed attempt, so it can be retried later', async () => {
    fake.behave = () => {
      throw new Error('LibreOffice stopped (SIGKILL)');
    };
    const r = await upload('vertrag.docx', makeDocx(['Mietvertrag']));
    await waitFor(async () => (await intake([r.intakeId!]))[0].status === 'failed', 10_000);
    // The maintenance would collect a file without a document after an hour – not this one.
    const sha = (h.ctx.db.prepare('SELECT sha256 FROM lib_intake WHERE id = ?').get(r.intakeId) as { sha256: string }).sha256;
    const file = local().blobs.pathOf(sha);
    const old = new Date(Date.now() - 3 * 3_600_000);
    fs.utimesSync(file, old, old);
    await local().maintenance.run();
    expect(fs.existsSync(file)).toBe(true);

    fake.behave = () => makePdf([['Mietvertrag']]);
    const retried = await h.inject({ method: 'POST', url: `/api/intake/${r.intakeId}/retry`, headers: { cookie }, payload: {} });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'stored' });
  });

  it('answers as before without background=true', async () => {
    expect(await upload('scan.pdf', makePdf([['Ein Brief']]), false)).toMatchObject({
      status: 'stored',
      documentId: expect.any(Number),
    });
  });
});
