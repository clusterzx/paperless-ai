import { afterEach, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import type { ChatRequestInfo } from '../helpers/mockLlm.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  h = await createHarness(opts);
  h.llm.reply((req: ChatRequestInfo) =>
    req.user.includes('Stadtwerke')
      ? analysisJson({ title: 'Stromrechnung November 2026', correspondent: 'Stadtwerke Musterstadt', tags: ['Rechnung'], document_type: 'Rechnung' })
      : analysisJson({ title: 'Something else', tags: ['Misc'] }),
  );
  return h;
}

/** The prompts the AI received. */
const prompts = (hh: Harness) => hh.llm.chatRequests().map((r) => JSON.stringify(r.body));

async function scan(hh: Harness): Promise<number> {
  const res = await hh.inject({ method: 'POST', url: '/api/processing/scan', headers: hh.apiKeyHeaders() });
  expect(res.statusCode).toBe(200);
  await hh.engine.drain(10_000);
  return res.json().queued as number;
}

const GOOD = 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Abrechnung für den Monat Oktober. Mit freundlichen Grüßen';
const GARBAGE = "Rchng Nr . l2O4 ; ' ~ | ] Mlrmstr Kpp l . ii| ,, Btrg : 4l2 ,8O EUR ~ _ ' | ; ° ¬ l1 I | ' . -- ' ; :";
const OCR_TEXT = 'Rechnung Nr. 4711 der Stadtwerke Musterstadt über 106,72 EUR vom 03.11.2026';

describe('automatic OCR before the AI analysis', () => {
  it('reads documents without or with garbled text in "poor" mode and analyses the OCR text', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'poor' } } });
    hh.paperless.addDocument({ id: 1, title: 'good.pdf', content: GOOD });
    hh.paperless.addDocument({ id: 2, title: 'garbled.pdf', content: GARBAGE });
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });

    expect(await scan(hh)).toBe(3);
    // Only the two bad documents were downloaded and read.
    expect(hh.ocrEngine.calls).toHaveLength(2);
    expect(hh.paperless.calls('GET', /^\/api\/documents\/\d+\/download\/$/).map((c) => c.path)).toEqual(
      expect.arrayContaining(['/api/documents/2/download/', '/api/documents/3/download/']),
    );
    expect(hh.paperless.calls('GET', '/api/documents/1/download/')).toHaveLength(0);
    // The AI saw the OCR text, not the garbage.
    expect(prompts(hh).filter((u) => u.includes(OCR_TEXT))).toHaveLength(2);
    expect(prompts(hh).some((u) => u.includes('Mlrmstr'))).toBe(false);
    // Written back (default) and then renamed by the AI pipeline.
    expect(hh.paperless.docs.get(2)!.content).toBe(OCR_TEXT);
    expect(hh.paperless.docs.get(2)!.title).toBe('Stromrechnung November 2026');
    expect(hh.ctx.repos.documents.get(2)?.status).toBe('processed');
  });

  it('reads only documents without text in "missing" mode', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'missing' } } });
    hh.paperless.addDocument({ id: 2, title: 'garbled.pdf', content: GARBAGE });
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
    await scan(hh);
    expect(hh.ocrEngine.calls).toHaveLength(1);
    expect(hh.paperless.docs.get(3)!.content).toBe(OCR_TEXT);
    expect(hh.paperless.docs.get(2)!.content).toBe(GARBAGE);
  });

  it('reads every document in "always" mode but never twice for the same version', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'always', writeBack: false } } });
    hh.paperless.addDocument({ id: 1, title: 'good.pdf', content: GOOD });
    await scan(hh);
    expect(hh.ocrEngine.calls).toHaveLength(1);
    // Re-analysing the same version uses the stored OCR text.
    hh.engine.enqueue(1, { source: 'manual', force: true });
    await hh.engine.drain(10_000);
    expect(hh.ocrEngine.calls).toHaveLength(1);
    expect(prompts(hh).at(-1)).toContain(OCR_TEXT);
  });

  it('does nothing automatically in manual mode or when disabled', async () => {
    for (const ocr of [{ enabled: true, mode: 'manual' as const }, { enabled: false, mode: 'always' as const }]) {
      const hh = await harness({ config: { ocr } });
      hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
      await scan(hh);
      expect(hh.ocrEngine.calls).toHaveLength(0);
      expect(hh.ctx.repos.documents.get(3)?.reason).toMatch(/No text content/);
      await hh.close();
      h = null;
    }
  });

  it('keeps the text local when write-back is off and uses it for the analysis', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'poor', writeBack: false } } });
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
    await scan(hh);
    expect(hh.paperless.docs.get(3)!.content).toBe('');
    expect(hh.paperless.patches(3).some((p) => 'content' in (p.body as object))).toBe(false);
    expect(prompts(hh)[0]).toContain(OCR_TEXT);
    expect(hh.ctx.repos.ocr.localText(3, hh.ctx.repos.ocr.result(3)!.source_modified)).toBe(OCR_TEXT);
  });

  it('continues with the Paperless text when OCR fails and never writes back an empty result', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'poor' } } });
    hh.ocrEngine.error = new Error('model download failed');
    hh.paperless.addDocument({ id: 2, title: 'garbled.pdf', content: GARBAGE });
    await scan(hh);
    expect(hh.ctx.repos.ocr.result(2)?.status).toBe('failed');
    expect(hh.ctx.repos.ocr.result(2)?.error).toContain('model download failed');
    expect(hh.ctx.repos.documents.get(2)?.status).toBe('processed');

    // Without any text a failed OCR is an error that is retried, not "no text".
    hh.paperless.addDocument({ id: 6, title: 'empty.pdf', content: '' });
    await scan(hh);
    expect(hh.ctx.repos.documents.get(6)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(hh.ctx.repos.documents.get(6)?.reason).toContain('OCR failed: model download failed');

    hh.ocrEngine.error = null;
    hh.ocrEngine.text = '  ';
    hh.paperless.addDocument({ id: 5, title: 'blank.pdf', content: '' });
    await scan(hh);
    expect(hh.paperless.patches(5).some((p) => 'content' in (p.body as object))).toBe(false);
    expect(hh.ctx.repos.documents.get(5)?.reason).toBe('No text found, not even with OCR');
  });

  it('picks up documents skipped for missing text once automatic OCR is enabled', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
    await scan(hh);
    expect(hh.ctx.repos.documents.get(3)?.status).toBe('skipped');
    hh.ctx.config.update({ ocr: { enabled: true, mode: 'missing' } });
    expect(await scan(hh)).toBe(1);
    expect(hh.ctx.repos.documents.get(3)?.status).toBe('processed');
    // Not queued again on the next scan.
    expect(await scan(hh)).toBe(0);
  });
});

describe('OCR page API', () => {
  it('lists the text quality of all documents with counts and filters', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'manual' } } });
    hh.paperless.addDocument({ id: 1, title: 'good.pdf', content: GOOD });
    hh.paperless.addDocument({ id: 2, title: 'garbled.pdf', content: GARBAGE });
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
    await hh.ocr.assessArchive();
    const cookie = await hh.login();

    const all = await hh.inject({ method: 'GET', url: '/api/ocr/documents', headers: { cookie } });
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i: { id: number }) => i.id)).toEqual([3, 2, 1]); // worst first
    expect(body.items[0].quality.level).toBe('missing');
    expect(body.items[1].quality.level).toBe('poor');
    expect(body.items[2].quality.level).toBe('good');
    expect(body.counts).toMatchObject({ all: 3, needs: 2, missing: 1, poor: 1, good: 1, done: 0 });

    const needs = await hh.inject({ method: 'GET', url: '/api/ocr/documents?filter=needs&search=garb', headers: { cookie } });
    expect(needs.json().items.map((i: { id: number }) => i.id)).toEqual([2]);
  });

  it('runs OCR on request, then the AI pipeline, and can revert the text', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'manual' } } });
    hh.paperless.addDocument({ id: 2, title: 'garbled.pdf', content: GARBAGE });
    await hh.ocr.assessArchive();
    const cookie = await hh.login();

    const run = await hh.inject({ method: 'POST', url: '/api/ocr/run', headers: { cookie }, payload: { filter: 'needs' } });
    expect(run.statusCode).toBe(200);
    expect(run.json().queued).toBe(1);
    await hh.engine.drain(10_000);

    expect(hh.paperless.docs.get(2)!.content).toBe(OCR_TEXT);
    expect(hh.paperless.docs.get(2)!.title).toBe('Stromrechnung November 2026');
    const list = (await hh.inject({ method: 'GET', url: '/api/ocr/documents?filter=done', headers: { cookie } })).json();
    expect(list.items[0]).toMatchObject({ id: 2, ocr: { status: 'done', writtenBack: true, provider: 'cpu' } });
    expect(list.counts.needs).toBe(0);

    const detail = (await hh.inject({ method: 'GET', url: '/api/ocr/documents/2', headers: { cookie } })).json();
    expect(detail).toMatchObject({ id: 2, paperlessText: OCR_TEXT, ocrText: OCR_TEXT });

    const revert = await hh.inject({ method: 'POST', url: '/api/ocr/documents/2/revert', headers: { cookie } });
    expect(revert.statusCode).toBe(200);
    expect(hh.paperless.docs.get(2)!.content).toBe(GARBAGE);
    const again = await hh.inject({ method: 'POST', url: '/api/ocr/documents/2/revert', headers: { cookie } });
    expect(again.statusCode).toBe(422);
  });

  it('refuses to run while OCR is disabled', async () => {
    const hh = await harness();
    hh.paperless.addDocument({ id: 3, title: 'empty.pdf', content: '' });
    const res = await hh.inject({ method: 'POST', url: '/api/ocr/run', headers: hh.apiKeyHeaders(), payload: { ids: [3] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/OCR is disabled/);
  });

  it('uses the archived PDF when the original is not a PDF or an image', async () => {
    const hh = await harness({ config: { ocr: { enabled: true, mode: 'missing' } } });
    hh.paperless.addDocument({
      id: 7,
      title: 'letter.docx',
      content: '',
      file: { data: Buffer.from('PK\u0003\u0004 docx'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      archive: Buffer.from('%PDF-1.7 archived'),
    });
    await scan(hh);
    expect(Buffer.from(hh.ocrEngine.calls[0].bytes).toString('latin1')).toContain('%PDF-1.7 archived');
  });

  it('reports the status with queue and analysis progress', async () => {
    const hh = await harness({ config: { ocr: { enabled: true } } });
    const res = await hh.inject({ method: 'GET', url: '/api/ocr/status', headers: hh.apiKeyHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, available: true, mode: 'poor', writeBack: true, queue: 0, active: null });
  });
});
