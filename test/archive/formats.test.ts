/**
 * File formats of the built-in archive: what a file is (from its content), the text of text files,
 * HTML pages and e-mails, and the safe extraction of the converter package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeText,
  detectType,
  looksLikeMail,
  oleStreams,
  textEncoding,
  UnsupportedFormat,
  zipEntries,
} from '../../src/server/archive/formats.js';
import {
  htmlTitle,
  htmlToText,
  mailPage,
  readMail,
  readTextFile,
  withoutRemoteResources,
} from '../../src/server/archive/textFormats.js';
import { extractTarGz } from '../../src/server/util/tar.js';
import { kindOf } from '../../src/shared/fileTypes.js';
import { makeTempDir } from '../helpers/appHarness.js';
import { makeDocx, makeOdf, makeOle, makeTarGz, makeZip } from '../helpers/office.js';
import { makePdf } from '../helpers/pdf.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const reason = (v: unknown) => (v instanceof UnsupportedFormat ? v.reason : v);

const MAIL = [
  'Return-Path: <rechnung@stadtwerke.example>',
  'From: Stadtwerke <rechnung@stadtwerke.example>',
  'To: Max Muster <max@example.com>',
  'Subject: =?utf-8?Q?Ihre_Rechnung_f=C3=BCr_M=C3=A4rz?=',
  'Date: Mon, 31 Mar 2025 23:30:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="B1"',
  '',
  '--B1',
  'Content-Type: multipart/alternative; boundary="B2"',
  '',
  '--B2',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Guten Tag, anbei Ihre Rechnung über 84,20 EUR.',
  '--B2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><title>Rechnung</title></head><body><p>Guten Tag, anbei Ihre <b>Rechnung</b> über 84,20 EUR.</p><img src="https://tracker.example/p.gif"></body></html>',
  '--B2--',
  '--B1',
  'Content-Type: application/pdf; name="rechnung.pdf"',
  'Content-Disposition: attachment; filename="rechnung.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  makePdf([['Rechnung']]).toString('base64'),
  '--B1--',
  '',
].join('\r\n');

describe('detectType', () => {
  it('knows PDFs and images by their signature', () => {
    expect(detectType(makePdf([['x']]), 'whatever.txt')).toBe('application/pdf');
    expect(detectType(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), 'a.pdf')).toBe('image/png');
    expect(detectType(Buffer.from('ffd8ffe000104a464946', 'hex'), 'x')).toBe('image/jpeg');
    const bmp = Buffer.alloc(54);
    bmp.write('BM', 0);
    bmp.writeUInt32LE(54, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    expect(detectType(bmp, 'x.bmp')).toBe('image/bmp');
    // Text that happens to start with "BM" is no bitmap.
    expect(detectType(Buffer.from('BMW Leasing – Vertrag Nr. 123\nRate: 299 EUR'), 'bmw.txt')).toBe('text/plain');
    expect(detectType(Buffer.from('{\\rtf1\\ansi Hallo}'), 'brief.rtf')).toBe('application/rtf');
  });

  it('tells the Office formats apart by their content, not their name', () => {
    expect(detectType(makeDocx(['Hallo']), 'brief.pdf')).toBe(DOCX);
    expect(
      detectType(
        makeZip([
          { name: '[Content_Types].xml', data: '<Types/>' },
          { name: 'xl/workbook.xml', data: '<workbook/>' },
        ]),
        'x',
      ),
    ).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(
      detectType(
        makeZip([
          { name: '[Content_Types].xml', data: '<Types/>' },
          { name: 'ppt/presentation.xml', data: '<p/>' },
        ]),
        'x',
      ),
    ).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(detectType(makeOdf('application/vnd.oasis.opendocument.text'), 'x.zip')).toBe(
      'application/vnd.oasis.opendocument.text',
    );
    expect(detectType(makeOdf('application/vnd.oasis.opendocument.spreadsheet-template'), 'x.ots')).toBe(
      'application/vnd.oasis.opendocument.spreadsheet',
    );
    expect(reason(detectType(makeOdf('application/vnd.oasis.opendocument.graphics'), 'x.odg'))).toMatch(
      /OpenDocument type is not supported/,
    );
    expect(detectType(makeOle(['WordDocument', '1Table', '\u0001CompObj']), 'x.bin')).toBe('application/msword');
    expect(detectType(makeOle(['Workbook']), 'x')).toBe('application/vnd.ms-excel');
    expect(
      detectType(
        makeOle(['Current User', 'PowerPoint Document', 'Pictures', 'SummaryInformation', 'DocumentSummaryInformation']),
        'x',
      ),
    ).toBe('application/vnd.ms-powerpoint');
    // A plain ZIP file is no document.
    expect(detectType(makeZip([{ name: 'photos/a.jpg', data: 'x' }]), 'photos.zip')).toBeNull();
  });

  it('says why some files are not taken', () => {
    expect(reason(detectType(makeOle(['EncryptedInfo', 'EncryptedPackage']), 'secret.docx'))).toMatch(/password-protected/);
    expect(reason(detectType(makeOle(['__substg1.0_0037001F', '__properties_version1.0']), 'mail.msg'))).toMatch(/\.msg.*\.eml/);
    expect(reason(detectType(Buffer.from('{"a": 1}'), 'data.json'))).toMatch(/\.json files are not supported/);
    expect(detectType(Buffer.from([0, 1, 2, 3, 0, 0, 9, 200]), 'blob')).toBeNull();
    expect(detectType(Buffer.alloc(0), 'empty.txt')).toBeNull();
  });

  it('reads text files: by extension, e-mails and HTML also by their content', () => {
    expect(detectType(Buffer.from('a;b\n1;2\n'), 'export.csv')).toBe('text/csv');
    expect(detectType(Buffer.from('# Notizen\n\n- eins'), 'notes.md')).toBe('text/markdown');
    expect(detectType(Buffer.from('Einkaufsliste: Milch'), 'liste')).toBe('text/plain');
    expect(detectType(Buffer.from(MAIL), 'message')).toBe('message/rfc822');
    expect(detectType(Buffer.from(MAIL), 'mail.txt')).toBe('message/rfc822');
    expect(detectType(Buffer.from('<!-- x -->\n<!DOCTYPE html><html><body>Hi</body></html>'), 'page')).toBe('text/html');
    expect(detectType(Buffer.from('<p>fragment</p>'), 'page.htm')).toBe('text/html');
  });

  it('maps every type to a kind', () => {
    expect(kindOf(DOCX)).toBe('office');
    expect(kindOf('message/rfc822')).toBe('mail');
    expect(kindOf('text/html; charset=utf-8')).toBe('html');
    expect(kindOf('application/zip')).toBeNull();
  });
});

describe('text encodings', () => {
  it('detects UTF-8, UTF-16 and Windows-1252 (Excel CSV exports) and decodes them', () => {
    expect(textEncoding(Buffer.from('Grüße', 'utf8'))).toBe('utf-8');
    const cp1252 = Buffer.from([...Buffer.from('Gr', 'latin1'), 0xfc, 0xdf, 0x65, 0x20, 0x80]);
    expect(textEncoding(cp1252)).toBe('windows-1252');
    expect(decodeText(cp1252)).toBe('Grüße €');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hallo\r\nWelt', 'utf16le')]);
    expect(textEncoding(utf16)).toBe('utf-16le');
    expect(decodeText(utf16)).toBe('Hallo\nWelt');
    const be = Buffer.from([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeText(be)).toBe('Hi');
    expect(decodeText(Buffer.from('﻿mit BOM'))).toBe('mit BOM');
  });

  it('only takes a header block with sender and subject (or date) for an e-mail', () => {
    expect(looksLikeMail('From: a@example.com\nSubject: Hallo\n\nText')).toBe(true);
    expect(
      looksLikeMail(
        'From a@example.com Mon Jan  1 00:00:00 2024\nFrom: a@example.com\nDate: Mon, 1 Jan 2024 10:00:00 +0100\n\nText',
      ),
    ).toBe(true);
    expect(looksLikeMail('From: me\nhello there')).toBe(false);
    expect(looksLikeMail('Subject: only a subject\n\nText')).toBe(false);
    expect(looksLikeMail('Notiz: Von: Max\nAn: Anna')).toBe(false);
  });
});

describe('containers', () => {
  it('lists ZIP entries from the central directory and OLE streams through the FAT', () => {
    expect(zipEntries(makeDocx(['x']))).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const many = Array.from({ length: 9 }, (_, i) => `Stream${i}`);
    expect(oleStreams(makeOle(many))).toEqual(['Root Entry', ...many]);
    expect(oleStreams(Buffer.from('not an ole file at all'))).toEqual([]);
  });
});

describe('text of HTML and e-mails', () => {
  it('reads an e-mail: headers, message, attachments, subject as title and the day it was sent', async () => {
    const m = await readMail(Buffer.from(MAIL));
    expect(m.subject).toBe('Ihre Rechnung für März');
    expect(m.attachments.map((a) => a.filename)).toEqual(['rechnung.pdf']);
    const t = await readTextFile(Buffer.from(MAIL), 'message/rfc822');
    expect(t.title).toBe('Ihre Rechnung für März');
    expect(t.text).toContain('From: Stadtwerke <rechnung@stadtwerke.example>');
    expect(t.text).toContain('Subject: Ihre Rechnung für März');
    expect(t.text).toContain('anbei Ihre Rechnung über 84,20 EUR');
    expect(t.text).toMatch(/Attachments: rechnung\.pdf$/);
    // 23:30 at +02:00 is 21:30 UTC – the local day of the server decides.
    expect(t.created).toMatch(/^2025-0(3-31|4-01)$/);
  });

  it('builds the page of an e-mail for the PDF: escaped headers on top, no remote content', async () => {
    const page = mailPage(
      await readMail(Buffer.from(MAIL.replace('To: Max Muster <max@example.com>', 'To: "<script>x</script>" <max@example.com>'))),
    );
    expect(page.indexOf('<table')).toBeGreaterThan(page.indexOf('<body>'));
    expect(page).toContain('&lt;script&gt;');
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('src="https://tracker.example');
    expect(page).toContain('data-removed-src="//tracker.example/p.gif"');
    expect(page).toContain('Attachments</th><td style="padding:2px 0">rechnung.pdf');
    // Without an HTML part the text is shown as it is.
    const plain = mailPage(await readMail(Buffer.from('From: a@example.com\r\nSubject: Kurz\r\n\r\n1 < 2 & 3 > 2\r\n')));
    expect(plain).toContain('<pre');
    expect(plain).toContain('1 &lt; 2 &amp; 3 &gt; 2');
  });

  it('reads HTML pages and Markdown', async () => {
    const html =
      '<!doctype html><html><head><title>Kündigung &amp; Rückgabe</title><style>p{color:red}</style></head><body><h1>Kündigung</h1><p>Hiermit kündige ich.</p><script>alert(1)</script></body></html>';
    expect(htmlTitle(html)).toBe('Kündigung & Rückgabe');
    const t = await readTextFile(Buffer.from(html), 'text/html');
    expect(t.title).toBe('Kündigung & Rückgabe');
    expect(t.text).toContain('Hiermit kündige ich.');
    expect(t.text).not.toContain('alert');
    expect(t.text).not.toContain('color:red');
    expect(htmlToText('<a href="https://x.example/very/long">Link</a>')).toBe('Link');
    expect(
      withoutRemoteResources(
        '<img src="https://a/b.png"><div style="background: url(\'http://a/c.png\')"></div><img src="data:image/png;base64,AA">',
      ),
    ).toBe(
      '<img data-removed-src="//a/b.png"><div style="background: url(\'about:blank#a/c.png\')"></div><img src="data:image/png;base64,AA">',
    );
    const md = await readTextFile(Buffer.from('Vorwort\n\n# Haushaltsbuch 2025\n\nText'), 'text/markdown');
    expect(md.title).toBe('Haushaltsbuch 2025');
  });

  it('reads deeply nested HTML quickly', () => {
    expect(htmlToText('<p>Hallo <b>Welt</b> &amp; mehr</p>')).toBe('Hallo Welt & mehr');
    const deep = `${'<div>'.repeat(200_000)}Rechnung 42 &amp; mehr${'</div>'.repeat(200_000)}`;
    const started = Date.now();
    expect(htmlToText(deep)).toContain('Rechnung 42 & mehr');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('extractTarGz', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes regular files below the target only (no links, nothing outside)', async () => {
    dir = makeTempDir();
    const long = `package/${'deep/'.repeat(25)}file.txt`;
    const archive = path.join(dir, 'p.tgz');
    fs.writeFileSync(
      archive,
      makeTarGz([
        { name: 'package/', type: '5' },
        { name: 'package/package.json', data: '{"name":"x"}' },
        { name: 'package/dist/a.js', data: 'export {};' },
        { name: 'package/dist/a.js.map', data: '{}' },
        { name: long, data: 'long name' },
        { name: 'package/../../evil.txt', data: 'evil' },
        { name: '/etc/evil.txt', data: 'evil' },
        { name: 'package/link', type: '2' },
      ]),
    );
    const out = path.join(dir, 'out');
    const n = await extractTarGz(archive, out, { strip: 1, skip: (f) => f.endsWith('.map') });
    expect(n).toBe(3);
    expect(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).toBe('{"name":"x"}');
    expect(fs.readFileSync(path.join(out, 'dist/a.js'), 'utf8')).toBe('export {};');
    expect(fs.existsSync(path.join(out, 'dist/a.js.map'))).toBe(false);
    expect(fs.readFileSync(path.join(out, long.slice('package/'.length)), 'utf8')).toBe('long name');
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'link'))).toBe(false);
  });
});
