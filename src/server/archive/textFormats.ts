/**
 * Text of the formats the archive reads without converting them: plain text, Markdown, CSV, HTML and
 * e-mails (.eml). For HTML and e-mails it also builds the page the Office converter turns into the
 * archived PDF (when it is switched on).
 */
import { convert } from 'html-to-text';
import { simpleParser, type AddressObject } from 'mailparser';
import { localDay } from '../../shared/dates.js';
import { decodeText } from './formats.js';

/** Longest text kept of a single file (a CSV export can be huge; the AI reads far less anyway). */
export const MAX_TEXT_CHARS = 5_000_000;

const cap = (text: string) =>
  text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… the rest of the file is not part of the text]` : text;

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlTitle(html: string): string | null {
  const start = html.search(/<title[\s>]/i);
  if (start < 0) return null;
  const open = html.indexOf('>', start);
  const close = html.toLowerCase().indexOf('</title', open);
  if (open < 0 || close < 0) return null;
  const title = htmlToText(html.slice(open + 1, Math.min(close, open + 2000)))
    .replace(/\s+/g, ' ')
    .trim();
  return title || null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Remote resources of a page are not loaded by the converter (it has no network); their addresses
 * are taken out anyway, so nothing waits for them and no tracking pixel is ever asked for.
 */
export function withoutRemoteResources(html: string): string {
  return html
    .replace(/\b(src|srcset|background|poster)(\s*=\s*["']?)(?:https?:)?\/\//gi, 'data-removed-$1$2//')
    .replace(/url\(\s*(["']?)(?:https?:)?\/\//gi, 'url($1about:blank#');
}

// ---------------------------------------------------------------- e-mails

export interface MailContent {
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** The Date header as sent. */
  dateLine: string;
  date: Date | null;
  text: string;
  html: string | null;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** "Name <address>, …" (mailparser's own text quotes every name). */
const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : [])
    .flatMap((x) => x.value)
    .map((v) => (v.name ? (v.address ? `${v.name} <${v.address}>` : v.name) : (v.address ?? '')))
    .filter(Boolean)
    .join(', ');

export async function readMail(bytes: Uint8Array): Promise<MailContent> {
  const mail = await simpleParser(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { skipTextToHtml: true });
  const html = typeof mail.html === 'string' && mail.html.trim() ? mail.html : null;
  const text = (mail.text?.trim() ? mail.text : html ? htmlToText(html) : '').replace(/\r\n?/g, '\n').trim();
  const dateLine =
    mail.headerLines
      .find((h) => h.key === 'date')
      ?.line.replace(/^date:\s*/i, '')
      .trim() ?? '';
  return {
    subject: (mail.subject ?? '').trim(),
    from: addresses(mail.from),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    dateLine,
    date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    text,
    html,
    attachments: mail.attachments
      .filter((a) => !a.related)
      .map((a) => ({ filename: a.filename ?? '(unnamed)', contentType: a.contentType, size: a.size })),
  };
}

function mailHeaders(m: MailContent): [string, string][] {
  return (
    [
      ['From', m.from],
      ['To', m.to],
      ['Cc', m.cc],
      ['Date', m.dateLine],
      ['Subject', m.subject],
    ] as [string, string][]
  ).filter(([, v]) => v);
}

const attachmentList = (m: MailContent) => m.attachments.map((a) => a.filename).join(', ');

/** The text of an e-mail as it is stored and searched: the headers, the message, the attachments. */
export function mailText(m: MailContent): string {
  const head = mailHeaders(m)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const tail = m.attachments.length ? `\n\nAttachments: ${attachmentList(m)}` : '';
  return cap(`${head}\n\n${m.text}${tail}`.trim());
}

/** The page of an e-mail for the PDF: a header table above the message as it was sent. */
export function mailPage(m: MailContent): string {
  const rows = mailHeaders(m)
    .map(
      ([k, v]) =>
        `<tr><th style="text-align:left;padding:2px 14px 2px 0;vertical-align:top;color:#555">${k}</th><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const attachments = m.attachments.length
    ? `<tr><th style="text-align:left;padding:2px 14px 2px 0;vertical-align:top;color:#555">Attachments</th><td style="padding:2px 0">${escapeHtml(attachmentList(m))}</td></tr>`
    : '';
  const header = `<table style="font-family:sans-serif;font-size:10pt;border-collapse:collapse;margin-bottom:6px">${rows}${attachments}</table><hr>`;
  if (!m.html) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title></head><body>${header}<pre style="white-space:pre-wrap;font-family:sans-serif;font-size:10pt">${escapeHtml(m.text)}</pre></body></html>`;
  }
  const body = withoutRemoteResources(m.html);
  const at = /<body\b[^>]*>/i.exec(body);
  if (at) return `${body.slice(0, at.index + at[0].length)}${header}${body.slice(at.index + at[0].length)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title></head><body>${header}${body}</body></html>`;
}

// ---------------------------------------------------------------- all text formats

export interface TextContent {
  text: string;
  title?: string;
  /** YYYY-MM-DD (the date an e-mail was sent). */
  created?: string;
  /** The page the converter turns into the archived PDF (HTML and e-mails). */
  page?: string;
}

export async function readTextFile(bytes: Uint8Array, mime: string): Promise<TextContent> {
  if (mime === 'message/rfc822') {
    const m = await readMail(bytes);
    return {
      text: mailText(m),
      title: m.subject || undefined,
      created: m.date ? localDay(m.date) : undefined,
      page: mailPage(m),
    };
  }
  // (Far more than is kept of the text – a huge file is not decoded as a whole.)
  const raw = decodeText(bytes.subarray(0, 4 * MAX_TEXT_CHARS));
  if (mime === 'text/html') {
    return { text: cap(htmlToText(raw)), title: htmlTitle(raw) ?? undefined, page: withoutRemoteResources(raw) };
  }
  if (mime === 'text/markdown') {
    const heading = /^#[ \t]+(\S[^\n]*)$/m.exec(raw.slice(0, 10_000))?.[1]?.trim();
    return { text: cap(raw.trim()), title: heading || undefined };
  }
  return { text: cap(raw.trim()) };
}
