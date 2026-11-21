/**
 * E-mail intake of the built-in archive (docs/standalone/ingest.md): the IMAP accounts of the
 * libraries are checked every few minutes; attachments (PDF, images) of new messages are stored.
 * Rules per account add tags, store without analysis or ignore messages by sender / subject.
 * Every attachment has its own intake reference (account, UIDVALIDITY, UID, part), so a message is
 * never stored twice, also when it is fetched again after a crash.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { LocalBackend } from './backend.js';
import { sniffType } from './files.js';
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
}

/** The part of an IMAP client the watcher needs (imapflow; a fake in tests). */
export interface MailClient {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidValidity: bigint | number; exists: number }>;
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
  /** Replaced by tests. */
  clientFactory: MailClientFactory = imapClient;

  constructor(private readonly backend: LocalBackend) {}

  private get ctx() {
    return this.backend.ctx;
  }

  start(): void {
    if (this.timer || process.env.PAPERLESS_AI_NO_WATCHERS === '1') return;
    const every = this.ctx.cfg.archive.builtin.mailPollMinutes * 60_000;
    this.timer = setInterval(() => void this.checkAll(), every);
    this.timer.unref();
    setTimeout(() => void this.checkAll(), 15_000).unref();
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

  accounts(): MailAccountRow[] {
    return this.ctx.db.prepare('SELECT * FROM intake_mail_accounts WHERE enabled = 1 ORDER BY id').all() as MailAccountRow[];
  }

  /** Check all enabled accounts (one run at a time). */
  async checkAll(): Promise<void> {
    if (this.running) return;
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
        // A new UIDVALIDITY means the folder was rebuilt: start over (the intake references prevent duplicates).
        const after = prev && prev.uidValidity === validity ? prev.lastUid : 0;
        const uids = ((await client.search({ uid: `${after + 1}:*` }, { uid: true })) || []).filter((u) => u > after).sort((x, y) => x - y).slice(0, MAX_PER_RUN);
        for (const uid of uids) {
          result.messages++;
          try {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg || !msg.source) continue;
            const outcome = await this.storeMessage(row, rules, await simpleParser(msg.source), `${row.id}:${folder}:${validity}:${uid}`);
            result.stored += outcome.stored;
            result.duplicates += outcome.duplicates;
            if (outcome.ignored) result.ignored++;
            // Done with the message: only when something was stored (others stay as they are).
            if (outcome.stored + outcome.duplicates > 0) {
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
      if (result.stored) log.info(`E-mail account "${row.name}": ${result.stored} attachment(s) stored`);
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

  private async storeMessage(row: MailAccountRow, rules: MailRule[], mail: ParsedMail, ref: string): Promise<{ stored: number; duplicates: number; ignored: boolean }> {
    const from = mail.from?.text ?? '';
    const subject = mail.subject ?? '';
    const rule = rules.find((r) => (!r.from || from.toLowerCase().includes(r.from.toLowerCase())) && (!r.subject || subject.toLowerCase().includes(r.subject.toLowerCase())));
    if (rule?.ignore) return { stored: 0, duplicates: 0, ignored: true };
    let stored = 0;
    let duplicates = 0;
    for (const [i, att] of mail.attachments.entries()) {
      const type = sniffType(att.content);
      if (!type) continue;
      // Logos and signatures in the text of the mail are no documents.
      if (att.contentDisposition === 'inline' && type.startsWith('image/') && att.size < 50_000) continue;
      const res = await this.backend.ingest(SYSTEM_SCOPE, { data: att.content, filename: att.filename || `attachment-${i + 1}.${type.split('/')[1]}` }, 'mail', {
        libraryId: row.library_id,
        tags: rule?.tags,
        skipAnalysis: rule?.skipAnalysis,
        channelRef: `${ref}:${i}`,
        context: { mail_from: from, mail_subject: subject },
      });
      if (res.status === 'stored') stored++;
      else if (res.status === 'duplicate') duplicates++;
    }
    return { stored, duplicates, ignored: false };
  }
}
