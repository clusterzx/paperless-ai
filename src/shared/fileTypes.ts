/** File types of the built-in archive (server and web interface). See src/server/archive/formats.ts. */

export type FileKind = 'pdf' | 'image' | 'text' | 'html' | 'mail' | 'office';

export const MIME_KINDS: Readonly<Record<string, FileKind>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/tiff': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/bmp': 'image',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'text/tab-separated-values': 'text',
  'text/html': 'html',
  'message/rfc822': 'mail',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'office',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'office',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'application/vnd.oasis.opendocument.text': 'office',
  'application/vnd.oasis.opendocument.spreadsheet': 'office',
  'application/vnd.oasis.opendocument.presentation': 'office',
  'application/msword': 'office',
  'application/vnd.ms-excel': 'office',
  'application/vnd.ms-powerpoint': 'office',
  'application/rtf': 'office',
};

export function kindOf(mime: string | null | undefined): FileKind | null {
  return (mime && MIME_KINDS[mime.split(';')[0].trim().toLowerCase()]) || null;
}

/** For file pickers (`accept`): always taken. */
export const ACCEPT_ALWAYS = 'application/pdf,image/*,.txt,.md,.markdown,.csv,.tsv,.html,.htm,.eml,message/rfc822';
/** For file pickers: taken with the Office converter. */
export const ACCEPT_OFFICE = '.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.rtf';

/** Short names of what is taken, for messages. */
export function acceptedFormats(office: boolean): string {
  return `PDF, images (JPEG, PNG, TIFF, WebP, GIF, BMP), text (TXT, Markdown, CSV), HTML, e-mails (EML)${office ? ', Office documents (Word, Excel, PowerPoint, OpenDocument, RTF)' : ''}`;
}
