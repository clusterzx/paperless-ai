/**
 * The real Office converter – opt-in, it needs ~80 MB of download and ~1.3 GB of memory:
 *   PAI_OFFICE_TEST=1 npx vitest run test/office
 * PAI_OFFICE_TARBALL=<path to libreoffice-converter-2.7.2.tgz> skips the download (offline install).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectFile } from '../../src/server/archive/files.js';
import { mailPage, readMail } from '../../src/server/archive/textFormats.js';
import type { AppContext } from '../../src/server/context.js';
import { CONVERTER_PACKAGE, OfficeService } from '../../src/server/office/service.js';
import { makeTempDir } from '../helpers/appHarness.js';
import { makeDocx } from '../helpers/office.js';

describe.skipIf(!process.env.PAI_OFFICE_TEST)('LibreOffice (WebAssembly)', () => {
  it(
    'installs the checked package, converts Word documents and e-mails to PDF and gives the memory back',
    { timeout: 900_000 },
    async () => {
      const dataDir = makeTempDir();
      const tarball = process.env.PAI_OFFICE_TARBALL;
      if (tarball) {
        fs.mkdirSync(path.join(dataDir, 'office'), { recursive: true });
        fs.copyFileSync(tarball, path.join(dataDir, 'office', `libreoffice-converter-${CONVERTER_PACKAGE.version}.tgz`));
      }
      const cfg = { archive: { builtin: { office: { enabled: true, idleMinutes: 5, timeoutSeconds: 300 } } } };
      const service = new OfficeService({ cfg, dataDir, config: new EventEmitter() } as unknown as AppContext);
      try {
        await service.install();
        expect(service.status()).toMatchObject({ state: 'ready', loaded: false });

        const pdf = await service.toPdf(makeDocx(['Mietvertrag für die Wohnung', 'Musterstraße 1, 12345 Musterstadt']), 'docx');
        expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
        const info = await inspectFile(pdf, 'application/pdf');
        expect(info.pages).toBe(1);
        expect(info.text).toContain('Mietvertrag für die Wohnung');
        expect(info.text).toContain('Musterstraße 1');
        expect(service.status()).toMatchObject({ loaded: true, conversions: 1 });

        const mail = await readMail(
          Buffer.from(
            'From: Hausverwaltung <info@hv.example>\r\nSubject: Nebenkosten 2024\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Nachzahlung: <b>212,40 EUR</b></p><img src="https://tracker.example/x.gif">\r\n',
          ),
        );
        const page = await service.toPdf(Buffer.from(mailPage(mail)), 'html');
        const pageText = (await inspectFile(page, 'application/pdf')).text;
        expect(pageText).toContain('Nebenkosten 2024');
        expect(pageText).toContain('212,40 EUR');

        service.unload('by the test');
        expect(service.status().loaded).toBe(false);
      } finally {
        service.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
