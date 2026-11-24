/**
 * E-mail intake of the built-in archive (docs/standalone/ingest.md): the IMAP accounts of the
 * libraries are checked every few minutes; attachments that are documents (PDF, images, text, Office
 * documents with the converter) of new messages are stored – and, when a rule says so, the e-mail
 * itself (.eml). Rules per account add tags, store without analysis or ignore messages by sender /
 * subject. Every attachment has its own intake reference (account, UIDVALIDITY, UID, part), so a
 * message is never stored twice, also when it is fetched again after a crash.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type Attachment, type ParsedMail } from 'mailparser';
import type { LocalBackend } from './backend.js';
import { imageSize } from './files.js';
import { detectType, extensionFor, kindOf } from './formats.js';
import { SYSTEM_SCOPE } from '../access/scope.js';
import { open as openSecret, seal } from '../util/secretBox.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'mail' });

export interface MailRule {
  /** Sender address or name contains this (case-insensitive). */
  from?: string;
  /** Subject contains this. */
  subject?: string;
  tags?: string[];
  /** Store, but do not run the AI analysis. */
  skipAnalysis?: boolean;
  /** Ignore matching messages. */
  ignore?: boolean;
  /** Store into this library instead of the account's (one mailbox for several libraries). */
  libraryId?: number;
  /** Store the e-mail itself (.eml): never (default), only without an attachment that is a document, always. */
  storeMail?: 'never' | 'no_attachments' | 'always';
}

export interface MailAccountRow {
  id: number;
  library_id: number;
  name: string;
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password_enc: string;
  folders: string;
  rules: string;
  after: 'seen' | 'move' | 'delete';
  after_folder: string | null;
  state: string;
  last_error: string | null;
  last_checked_at: number | null;
  enabled: number;
  /** 1: the first check of a folder skips the messages already there. */
  skip_existing: number;
}

/** The part of an IMAP client the watcher needs (imapflow; a fake in tests). */
export interface MailClient {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidValidity: bigint | number; exists: number; uidNext?: number }>;
  search(query: { uid: string }, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchOne(uid: string, query: { source: true }, options: { uid: true }): Promise<{ source?: Buffer } | false>;
  messageFlagsAdd(uid: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(uid: string, destination: string, options: { uid: true }): Promise<unknown>;
  messageDelete(uid: string, options: { uid: true }): Promise<boolean>;
  list(): Promise<{ path: string }[]>;
  logout(): Promise<void>;
  /** What the server announced after connecting (imapflow: e.g. MOVE, UIDPLUS). */
  capabilities?: Map<string, boolean | number>;
}

/**
 * How a processed message can be removed from its folder without touching any other message.
 * Deleting ends with EXPUNGE; only `UID EXPUNGE` (UIDPLUS) is limited to the one message – a plain
 * EXPUNGE also removes every message another mail client flagged \Deleted and has not purged yet.
 * Moving is safe with MOVE, or with UIDPLUS (copy, then remove just that message).
 */
export function safeRemoval(client: Pick<MailClient, 'capabilities'>): { move: boolean; delete: boolean } {
  const caps = client.capabilities ?? new Map();
  return { move: caps.has('MOVE') || caps.has('UIDPLUS'), delete: caps.has('UIDPLUS') };
}

export type MailClientFactory = (account: { host: string; port: number; security: MailAccountRow['security']; username: string; password: string }) => MailClient;

export const imapClient: MailClientFactory = (a) =>
  new ImapFlow({
    host: a.host,
    port: a.port,
    secure: a.security === 'tls',
    doSTARTTLS: a.security === 'starttls' ? true : a.security === 'none' ? false : undefined,
    auth: { user: a.username, pass: a.password },
    logger: false,
    connectionTimeout: 30_000,
  }) as unknown as MailClient;

const MAX_PER_RUN = 200;

/**
 * Whether an image attachment is decoration of the mail rather than a document: logos, icons,
 * avatars, signatures, banners and tracking pixels. Mail clients do not mark them reliably
 * (Outlook, for one, turns embedded pictures into "Unnamed attachment 00044.png" attachments),
 * so the size of the picture decides:
 * - smaller than a readable page (longer side < 700 px or shorter side < 250 px): decoration;
 * - part of the HTML text (multipart/related): decoration unless it is as large as a photo or scan
 *   (longer side >= 1500 px). Photos sent from phones are "inline" but not related, so they stay.
 * Without sharp the dimensions are unknown: embedded pictures below 200 KB and any below 10 KB.
 */
export async function isMailDecoration(att: Pick<Attachment, 'content' | 'size' | 'contentDisposition' | 'related'>): Promise<boolean> {
  const dims = await imageSize(att.content);
  if (!dims) return att.size < 10_000 || ((att.related || att.contentDisposition === 'inline') && att.size < 200_000);
  const long = Math.max(dims.width, dims.height);
  const short = Math.min(dims.width, dims.height);
  if (long < 700 || short < 250) return true;
  return Boolean(att.related) && long < 1500;
}

export interface MailCheckResult {
  messages: number;
  stored: number;
  duplicates: number;
  ignored: number;
  errors: string[];
}

export class MailWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private lastRunAt = 0;
  /** Replaced by tests. */
  clientFactory: MailClientFactory = imapClient;

  constructor(private readonly backend: LocalBackend) {}

  private get ctx() {
    return this.backend.ctx;
  }

  start(): void {
    if (this.timer || process.env.PAPERLESS_AI_NO_WATCHERS === '1') return;
    // A tick every minute checks once the interval (Settings → Archive) has passed, so a changed
    // interval applies right away instead of after the old one.
    this.timer = setInterval(() => {
      if (this.due()) void this.checkAll();
    }, 60_000);
    this.timer.unref();
    setTimeout(() => void this.checkAll(), 15_000).unref();
  }

  /** Whether the next automatic check is due (a few seconds early, so timer drift skips no tick). */
  due(now = Date.now()): boolean {
    return now - this.lastRunAt >= this.ctx.cfg.archive.builtin.mailPollMinutes * 60_000 - 5_000;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  password(row: Pick<MailAccountRow, 'password_enc'>): string {
    const p = openSecret(row.password_enc, this.ctx.cfg.security.jwtSecret, 'mail');
    if (p === null) throw new Error('The stored password cannot be read (the instance secret changed) – enter it again');
    return p;
  }

  sealPassword(password: string): string {
    return seal(password, this.ctx.cfg.security.jwtSecret, 'mail');
  }

  /** Enabled accounts of libraries that exist (not deleted). */
  accounts(): MailAccountRow[] {
    return this.ctx.db
      .prepare('SELECT a.* FROM intake_mail_accounts a JOIN libraries l ON l.id = a.library_id AND l.deleted_at IS NULL WHERE a.enabled = 1 ORDER BY a.id')
      .all() as MailAccountRow[];
  }

  /** Check all enabled accounts (one run at a time). */
  async checkAll(): Promise<void> {
    if (this.running) return;
    this.lastRunAt = Date.now();
    const run = (async () => {
      for (const a of this.accounts()) await this.check(a.id).catch(() => undefined);
    })();
    this.running = run;
    try {
      await run;
    } finally {
      this.running = null;
    }
  }

  /** Test the connection of (unsaved) account settings: the folders on success. */
  async test(a: { host: string; port: number; security: MailAccountRow['security']; username: string; password: string }): Promise<string[]> {
    const client = this.clientFactory(a);
    await client.connect();
    try {
      return (await client.list()).map((f) => f.path);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async check(accountId: number): Promise<MailCheckResult> {
    const row = this.ctx.db.prepare('SELECT * FROM intake_mail_accounts WHERE id = ?').get(accountId) as MailAccountRow | undefined;
    const result: MailCheckResult = { messages: 0, stored: 0, duplicates: 0, ignored: 0, errors: [] };
    if (!row) return result;
    const state = JSON.parse(row.state || '{}') as Record<string, { uidValidity: string; lastUid: number }>;
    let client: MailClient | null = null;
    try {
      client = this.clientFactory({ host: row.host, port: row.port, security: row.security, username: row.username, password: this.password(row) });
      await client.connect();
      const safe = safeRemoval(client);
      if (row.after === 'move' && !safe.move) {
        result.errors.push('The mail server cannot move a single message (no MOVE or UIDPLUS) – processed messages are only marked as read');
      }
      const rules = JSON.parse(row.rules || '[]') as MailRule[];
      for (const folder of JSON.parse(row.folders || '["INBOX"]') as string[]) {
        const box = await client.mailboxOpen(folder);
        const validity = String(box.uidValidity);
        const prev = state[folder];
        // "Only new e-mails": the first look at a folder remembers where it ends and reads nothing.
        if (!prev && row.skip_existing) {
          const last = box.uidNext ? box.uidNext - 1 : Math.max(0, ...(((await client.search({ uid: '1:*' }, { uid: true })) || []) as number[]));
          state[folder] = { uidValidity: validity, lastUid: last };
          continue;
        }
        // A new UIDVALIDITY means the folder was rebuilt: start over (the intake references prevent duplicates).
        const after = prev && prev.uidValidity === validity ? prev.lastUid : 0;
        const uids = ((await client.search({ uid: `${after + 1}:*` }, { uid: true })) || []).filter((u) => u > after).sort((x, y) => x - y).slice(0, MAX_PER_RUN);
        for (const uid of uids) {
          result.messages++;
          try {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const outcome = await this.storeMessage(row, rules, msg.source, await simpleParser(msg.source), `${row.id}:${folder}:${validity}:${uid}`);
            result.stored += outcome.stored;
            result.duplicates += outcome.duplicates;
            if (outcome.ignored) result.ignored++;
            // A refused attachment (too large, a type that is not accepted): the message stays as it
            // is – unread, in its folder – so nothing of it is lost; the account shows why.
            if (outcome.refused.length) {
              result.errors.push(`Message ${uid}: ${outcome.refused.join('; ')} – the message was left in the mailbox`);
            }
            // Done with the message: only when something was stored and nothing was refused (others stay as they are).
            else if (outcome.stored + outcome.duplicates > 0) {
              // Only this message is ever changed: without UIDPLUS a deletion is just the \Deleted
              // flag (the mail client purges it later) and a move falls back to marking it read.
              if (row.after === 'delete' && safe.delete) await client.messageDelete(String(uid), { uid: true });
              else if (row.after === 'delete') await client.messageFlagsAdd(String(uid), ['\\Seen', '\\Deleted'], { uid: true });
              else if (row.after === 'move' && row.after_folder && safe.move) await client.messageMove(String(uid), row.after_folder, { uid: true });
              else await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            }
          } catch (err) {
            result.errors.push(`Message ${uid}: ${describeError(err)}`);
            log.warn(`E-mail account "${row.name}", ${folder} message ${uid}: ${describeError(err)}`);
            // Not past a message that failed – it is tried again next time.
            break;
          }
          state[folder] = { uidValidity: validity, lastUid: uid };
        }
      }
      this.ctx.db
        .prepare('UPDATE intake_mail_accounts SET state = ?, last_error = ?, last_checked_at = ? WHERE id = ?')
        .run(JSON.stringify(state), result.errors[0] ?? null, Date.now(), row.id);
      if (result.stored) log.info(`E-mail account "${row.name}": ${result.stored} document(s) stored`);
    } catch (err) {
      const message = describeError(err);
      result.errors.push(message);
      this.ctx.db.prepare('UPDATE intake_mail_accounts SET state = ?, last_error = ?, last_checked_at = ? WHERE id = ?').run(JSON.stringify(state), message, Date.now(), row.id);
      log.warn(`E-mail account "${row.name}" could not be checked: ${message}`);
    } finally {
      await client?.logout().catch(() => undefined);
    }
    return result;
  }

  /**
   * Store the attachments of a message. A passing failure of one attachment throws (the message is
   * read again next time; attachments stored already are not stored twice); refused attachments are
   * returned, so the message is left in the mailbox.
   */
  private async storeMessage(row: MailAccountRow, rules: MailRule[], source: Buffer, mail: ParsedMail, ref: string): Promise<{ stored: number; duplicates: number; refused: string[]; ignored: boolean }> {
    const from = mail.from?.text ?? '';
    const subject = mail.subject ?? '';
    const rule = rules.find((r) => (!r.from || from.toLowerCase().includes(r.from.toLowerCase())) && (!r.subject || subject.toLowerCase().includes(r.subject.toLowerCase())));
    if (rule?.ignore) return { stored: 0, duplicates: 0, refused: [], ignored: true };
    // The library of the rule, as long as it exists; else the account's.
    const ruleLibrary = rule?.libraryId ? this.ctx.repos.libraries.get(rule.libraryId) : undefined;
    const libraryId = ruleLibrary && !ruleLibrary.deleted_at ? ruleLibrary.id : row.library_id;
    let stored = 0;
    let duplicates = 0;
    let documents = 0;
    const refused: string[] = [];
    const store = async (data: Buffer, filename: string, channelRef: string, title?: string) => {
      const res = await this.backend.ingest(SYSTEM_SCOPE, { data, filename }, 'mail', {
        libraryId,
        tags: rule?.tags,
        skipAnalysis: rule?.skipAnalysis,
        channelRef,
        title,
        context: { mail_from: from, mail_subject: subject },
      });
      if (res.status === 'stored') stored++;
      else if (res.status === 'duplicate') duplicates++;
      else if (res.status === 'failed') throw new Error(`"${filename}" could not be stored (${res.reason ?? 'unknown error'}) – tried again with the next check`);
      else refused.push(`"${filename}" was refused (${res.reason ?? 'not accepted'})`);
    };
    for (const [i, att] of mail.attachments.entries()) {
      const type = this.documentType(att);
      if (!type) continue;
      // Logos, icons and signatures are no documents.
      if (type.startsWith('image/') && (await isMailDecoration(att))) continue;
      documents++;
      await store(att.content, att.filename || `attachment-${i + 1}.${extensionFor(type)}`, `${ref}:${i}`);
    }
    const storeMail = rule?.storeMail ?? 'never';
    if (storeMail === 'always' || (storeMail === 'no_attachments' && documents === 0)) {
      const printable = [...subject].filter((c) => c.charCodeAt(0) >= 32).join('');
      const name = printable.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'E-mail';
      await store(source, `${name}.eml`, `${ref}:mail`, subject.trim() || undefined);
    }
    return { stored, duplicates, refused, ignored: false };
  }

  /**
   * Whether an attachment is a document the archive takes: PDFs, images, text files with a name,
   * attached e-mails – Office documents only with the converter (otherwise they are left out, as
   * before, rather than refused). HTML parts and unknown files are no documents.
   */
  private documentType(att: Attachment): string | null {
    const type = detectType(att.content, att.filename ?? '');
    if (typeof type !== 'string') return null;
    const kind = kindOf(type);
    const ok = kind === 'pdf' || kind === 'image' || kind === 'mail' || (kind === 'text' && Boolean(att.filename)) || (kind === 'office' && this.backend.office.enabled);
    return ok ? type : null;
  }
}
