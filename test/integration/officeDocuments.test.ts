/**
 * Text files, HTML, e-mails and Office documents in the built-in archive. LibreOffice is replaced by
 * a fake engine (test/helpers/office.ts); the real one: test/office/libreoffice.test.ts (opt-in).
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, DocumentVersionInfo, OfficeStatus, UploadResult } from '../../src/shared/api.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import type { AppContext } from '../../src/server/context.js';
import { OfficeRefused, OfficeService } from '../../src/server/office/service.js';
import { createHarness, makeTempDir, type Harness } from '../helpers/appHarness.js';
import { FakeOfficeEngine, makeDocx } from '../helpers/office.js';

let h: Harness;
let cookie: string;
let fake: FakeOfficeEngine;

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
  fake = new FakeOfficeEngine();
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;

function enableOffice(): void {
  local().office.engineFactory = () => fake;
  h.ctx.config.update({ archive: { builtin: { office: { enabled: true } } } });
}

async function upload(name: string, data: Buffer, type = 'application/octet-stream'): Promise<UploadResult> {
  const boundary = 'XBOUNDARYX';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="skipAnalysis"\r\n\r\ntrue\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await h.inject({
    method: 'POST',
    url: '/api/documents/upload',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: UploadResult[] }).results[0];
}

const detail = async (id: number) =>
  (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
const file = (id: number, query = '') =>
  h.inject({ method: 'GET', url: `/api/documents/${id}/file${query}`, headers: { cookie } });

const MAIL = [
  'From: Hausverwaltung Muster <info@hv.example>',
  'To: max@example.com',
  'Subject: Nebenkostenabrechnung 2024',
  'Date: Tue, 15 Apr 2025 10:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Die Nachzahlung beträgt <b>212,40 EUR</b>.</p><img src="https://tracker.example/open.gif"></body></html>',
  '',
].join('\r\n');

describe('text files and e-mails (always on)', () => {
  it('stores text in any common encoding, with its text, a thumbnail and the right charset', async () => {
    const csv = Buffer.from([
      ...Buffer.from('Datum;Empf', 'latin1'),
      0xe4,
      ...Buffer.from('nger;Betrag\r\n01.03.;Stadtwerke M', 'latin1'),
      0xfc,
      ...Buffer.from('nchen;84,20 ', 'latin1'),
      0x80,
      0x0d,
      0x0a,
    ]);
    const r = await upload('konto.csv', csv, 'text/csv');
    expect(r.status, r.reason).toBe('stored');
    const doc = await detail(r.documentId!);
    expect(doc.mime_type).toBe('text/csv');
    expect(doc.content).toBe('Datum;Empfänger;Betrag\n01.03.;Stadtwerke München;84,20 €');
    expect(doc.has_archive).toBe(false);
    const f = await file(doc.id, '?original=true');
    expect(f.headers['content-type']).toBe('text/csv; charset=windows-1252');
    expect(f.rawPayload.equals(csv)).toBe(true);
    const thumb = await h.inject({ method: 'GET', url: `/api/documents/${doc.id}/thumb`, headers: { cookie } });
    expect(thumb.headers['content-type']).toBe('image/webp');
  });

  it('stores an e-mail with its sender, subject, date and message; OCR leaves it alone', async () => {
    const r = await upload('nebenkosten.eml', Buffer.from(MAIL), 'message/rfc822');
    expect(r.status, r.reason).toBe('stored');
    const doc = await detail(r.documentId!);
    expect(doc.title).toBe('Nebenkostenabrechnung 2024');
    expect(doc.created).toBe('2025-04-15');
    expect(doc.mime_type).toBe('message/rfc822');
    expect(doc.content).toContain('From: Hausverwaltung Muster <info@hv.example>');
    expect(doc.content).toContain('Die Nachzahlung beträgt 212,40 EUR.');
    expect(h.ocr.autoNeeded({ ...(await h.ctx.backend().getDocument(doc.id)), content: '' })).toBe(false);
  });

  it('serves HTML only sandboxed (no scripts, nothing loaded from elsewhere)', async () => {
    const r = await upload(
      'seite.html',
      Buffer.from(
        '<!doctype html><html><head><title>Kündigung</title></head><body><p>Hiermit kündige ich.</p><script>alert(1)</script></body></html>',
      ),
      'text/html',
    );
    const doc = await detail(r.documentId!);
    expect(doc.title).toBe('Kündigung');
    expect(doc.content).toBe('Hiermit kündige ich.');
    const f = await file(doc.id, '?original=true');
    expect(f.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(f.headers['content-disposition']).toMatch(/^inline/);
    expect(f.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
  });
});

describe('Office documents', () => {
  it('are refused with a hint while the converter is off', async () => {
    const r = await upload('vertrag.docx', makeDocx(['Mietvertrag']));
    expect(r.status).toBe('rejected');
    expect(r.reason).toMatch(/Office converter.*Settings → Archive/);
    expect(fake.calls).toHaveLength(0);
  });

  it('become a PDF next to the original: shown, searched and offered to the apps', async () => {
    enableOffice();
    const docx = makeDocx(['Mietvertrag für die Wohnung']);
    const r = await upload('mietvertrag.docx', docx);
    expect(r.status, r.reason).toBe('stored');
    expect(fake.calls.map((c) => c.ext)).toEqual(['docx']);
    const doc = await detail(r.documentId!);
    expect(doc.mime_type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(doc.has_archive).toBe(true);
    expect(doc.page_count).toBe(1);
    expect(doc.content).toContain('Musterstraße 1, 12345 Musterstadt');
    // The file is the PDF; the original stays as it was uploaded.
    const pdf = await file(doc.id);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('mietvertrag.pdf');
    const original = await file(doc.id, '?original=true');
    expect(original.rawPayload.equals(docx)).toBe(true);
    const versions = (
      await h.inject({ method: 'GET', url: `/api/documents/${doc.id}/versions`, headers: { cookie } })
    ).json() as DocumentVersionInfo[];
    expect(versions.map((v) => [v.version, v.kind, v.mimeType])).toEqual([
      [1, 'archive', 'application/pdf'],
      [1, 'original', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ]);

    // Paperless-ngx apps: the archive version is there.
    const key = h.apiKeyHeaders();
    const ngx = (await h.inject({ method: 'GET', url: `/ngx/api/documents/${doc.id}/`, headers: key })).json() as {
      archived_file_name: string | null;
    };
    expect(ngx.archived_file_name).toBe('mietvertrag.pdf');
    const meta = (await h.inject({ method: 'GET', url: `/ngx/api/documents/${doc.id}/metadata/`, headers: key })).json() as {
      has_archive_version: boolean;
      archive_size: number;
    };
    expect(meta.has_archive_version).toBe(true);
    expect(meta.archive_size).toBeGreaterThan(100);

    // A new version gets its own PDF.
    fake.lines = ['Mietvertrag - Nachtrag 2025'];
    const boundary = 'VB';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nachtrag.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      makeDocx(['Nachtrag']),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const v2 = await h.inject({
      method: 'POST',
      url: `/api/documents/${doc.id}/versions`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(v2.statusCode, v2.body).toBe(200);
    expect((await detail(doc.id)).content).toBe('Mietvertrag - Nachtrag 2025');
    expect((await file(doc.id)).headers['content-disposition']).toContain('nachtrag.pdf');
  });

  it('keeps HTML and e-mails as PDF too while the converter is on (the text is still their own)', async () => {
    enableOffice();
    const r = await upload('nebenkosten.eml', Buffer.from(MAIL));
    const doc = await detail(r.documentId!);
    expect(doc.has_archive).toBe(true);
    expect(doc.content).toContain('Die Nachzahlung beträgt 212,40 EUR.');
    expect(fake.calls.map((c) => c.ext)).toEqual(['html']);
    const page = fake.calls[0].text;
    expect(page).toContain('Nebenkostenabrechnung 2024');
    expect(page).not.toContain('https://tracker.example');

    // A failing conversion of an e-mail is no reason to refuse it.
    fake.behave = () => {
      throw new OfficeRefused('broken page');
    };
    const r2 = await upload('seite.html', Buffer.from('<html><body>Hallo</body></html>'));
    expect(r2.status).toBe('stored');
    expect((await detail(r2.documentId!)).has_archive).toBe(false);
  });

  it('tries a hanging conversion once more in a fresh process; a file LibreOffice cannot read is refused', async () => {
    enableOffice();
    fake.behave = (call) => {
      if (call === 1) throw new Error('the conversion took longer than 120 s');
      return Buffer.from('%PDF-1.4\n%%EOF\n');
    };
    expect((await upload('a.docx', makeDocx(['eins']))).status).toBe('stored');
    expect([fake.starts, fake.stops]).toEqual([2, 1]);

    fake.behave = () => {
      throw new Error('LibreOffice stopped (SIGKILL)');
    };
    const failed = await upload('b.docx', makeDocx(['zwei']));
    expect(failed.status).toBe('failed'); // retryable
    expect(failed.reason).toMatch(/did not finish.*tried again later/);

    fake.behave = () => {
      throw new OfficeRefused('General input/output error');
    };
    const refused = await upload('c.docx', makeDocx(['drei']));
    expect(refused.status).toBe('rejected');
    expect(refused.reason).toMatch(/LibreOffice could not convert this file: General input\/output error/);
    const status = (await h.inject({ method: 'GET', url: '/api/archive/office', headers: { cookie } })).json() as OfficeStatus;
    expect(status).toMatchObject({ enabled: true, state: 'ready', conversions: 1, failures: 2 });
  });

  it('says while it is not installed yet that the file can come again later', async () => {
    // (No download in tests.)
    const office = local().office;
    const install = vi.spyOn(office, 'install').mockReturnValue(new Promise(() => undefined));
    h.ctx.config.update({ archive: { builtin: { office: { enabled: true } } } });
    expect(install).toHaveBeenCalled(); // switching it on starts the download
    const r = await upload('a.docx', makeDocx(['eins']));
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/being downloaded/);
    expect(office.status().state).toBe('not_installed');
  });
});

describe('OfficeService', () => {
  it('unloads LibreOffice when idle and when switched off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const config = new EventEmitter();
      const cfg = { archive: { builtin: { office: { enabled: true, idleMinutes: 3, timeoutSeconds: 60 } } } };
      const ctx = { cfg, dataDir: makeTempDir(), config } as unknown as AppContext;
      const service = new OfficeService(ctx, { watchConfig: true });
      const engine = new FakeOfficeEngine();
      service.engineFactory = () => engine;
      await service.toPdf(Buffer.from('x'), 'docx');
      expect(service.status()).toMatchObject({ loaded: true, conversions: 1 });
      vi.advanceTimersByTime(2 * 60_000);
      expect(engine.loaded).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(engine.loaded).toBe(false);

      await service.toPdf(Buffer.from('x'), 'docx');
      expect(engine.starts).toBe(2);
      cfg.archive.builtin.office.enabled = false;
      config.emit('change', cfg);
      expect(engine.loaded).toBe(false);
      await expect(service.toPdf(Buffer.from('x'), 'docx')).rejects.toMatchObject({ status: 415 });
      service.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
