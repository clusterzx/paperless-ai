/**
 * What the intake learns from a file before it is stored: its text, page count, a title and date
 * where the file has them (HTML title, e-mail subject and date) and – with the Office converter – an
 * archived PDF (Office documents always; HTML pages and e-mails when the converter is on).
 */
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import type { OfficeService } from '../office/service.js';
import { inspectFile } from './files.js';
import { kindOf, OFFICE_EXTENSIONS } from './formats.js';
import { readTextFile } from './textFormats.js';

const log = logger.child({ module: 'intake' });

export interface PreparedFile {
  text: string;
  pages: number | null;
  /** A PDF made of the file (kept next to the original). */
  archive: Uint8Array | null;
  title?: string;
  /** YYYY-MM-DD */
  created?: string;
}

export type Converter = Pick<OfficeService, 'ready' | 'toPdf'>;

export async function prepareFile(bytes: Uint8Array, mime: string, office: Converter | null): Promise<PreparedFile> {
  const kind = kindOf(mime);
  if (kind === 'office') {
    if (!office) throw new Error('No Office converter');
    const pdf = await office.toPdf(bytes, OFFICE_EXTENSIONS[mime] ?? 'docx');
    const info = await inspectFile(pdf, 'application/pdf');
    return { text: info.text, pages: info.pages, archive: pdf };
  }
  if (kind === 'text' || kind === 'html' || kind === 'mail') {
    const content = await readTextFile(bytes, mime);
    let archive: Uint8Array | null = null;
    let pages: number | null = null;
    // A faithful PDF of HTML pages and e-mails (layout, pictures) – the text is read either way.
    if (content.page && office?.ready()) {
      try {
        archive = await office.toPdf(Buffer.from(content.page, 'utf8'), 'html');
        pages = (await inspectFile(archive, 'application/pdf')).pages;
      } catch (err) {
        log.warn(`No PDF of the ${kind === 'mail' ? 'e-mail' : 'page'} (it is stored with its text): ${describeError(err)}`);
      }
    }
    return { text: content.text, pages, archive, title: content.title, created: content.created };
  }
  const info = await inspectFile(bytes, mime);
  return { text: info.text, pages: info.pages, archive: null };
}
