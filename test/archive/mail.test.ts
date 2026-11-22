/**
 * E-mail intake with a fake IMAP server: attachments are stored once (also when a message is
 * fetched again), rules add tags / skip the analysis / ignore senders, messages are marked or
 * moved afterwards, and the password is stored encrypted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import sharp from 'sharp';
import { isMailDecoration, type MailClient } from '../../src/server/archive/mail.js';
import type { MailAccountInfo } from '../../src/shared/api.js';

interface FakeMessage {
  source: Buffer;
  flags: Set<string>;
}

class FakeImap {
  folders = new Map<string, { uidValidity: number; messages: Map<number, FakeMessage> }>([['INBOX', { uidValidity: 7, messages: new Map() }], ['Archived', { uidValidity: 9, messages: new Map() }]]);
  logins: string[] = [];
  /** What the server announces; MOVE and UIDPLUS as most servers do. */
  caps = new Map<string, boolean | number>([
    ['MOVE', true],
    ['UIDPLUS', true],
  ]);
  private nextUid = 1;

  add(source: string, folder = 'INBOX', flags: string[] = []): number {
    const uid = this.nextUid++;
    this.folders.get(folder)!.messages.set(uid, { source: Buffer.from(source), flags: new Set(flags) });
    return uid;
  }

  client(password: string): MailClient {
    let open = 'INBOX';
    const box = () => this.folders.get(open)!;
    return {
      connect: async () => {
        if (password !== 'imap-secret') throw new Error('Authentication failed');
        this.logins.push(password);
      },
      mailboxOpen: async (path) => {
        open = path;
        return { uidValidity: BigInt(box().uidValidity), exists: box().messages.size };
      },
      search: async (q) => {
        const from = Number(q.uid.split(':')[0]);
        return [...box().messages.keys()].filter((u) => u >= from);
      },
      fetchOne: async (uid) => {
        const m = box().messages.get(Number(uid));
        return m ? { source: m.source } : false;
      },
      messageFlagsAdd: async (uid, flags) => {
        for (const f of flags) box().messages.get(Number(uid))?.flags.add(f);
        return true;
      },
      messageMove: async (uid, dest) => {
        const m = box().messages.get(Number(uid))!;
        box().messages.delete(Number(uid));
        this.folders.get(dest)!.messages.set(Number(uid), m);
        return true;
      },
      // As imapflow: without UIDPLUS the deletion ends with a plain EXPUNGE, which also removes
      // every other message flagged \Deleted.
      messageDelete: async (uid) => {
        if (!this.caps.has('UIDPLUS')) for (const [u, m] of box().messages) if (m.flags.has('\\Deleted')) box().messages.delete(u);
        return box().messages.delete(Number(uid));
      },
      list: async () => [...this.folders.keys()].map((path) => ({ path })),
      logout: async () => undefined,
      capabilities: this.caps,
    };
  }
}

const image = (width: number, height: number, format: 'png' | 'jpeg' | 'gif' = 'png') => sharp({ create: { width, height, channels: 3, background: '#f4f4f4' } }).toFormat(format).toBuffer();

function message(opts: { from: string; subject: string; attachments: { name: string; data: Buffer; type: string; inline?: boolean }[] }): string {
  const b = 'BOUNDARY42';
  const parts = [
    `From: ${opts.from}`,
    'To: archive@example.com',
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Siehe Anhang.',
  ];
  for (const a of opts.attachments) {
    parts.push(
      `--${b}`,
      `Content-Type: ${a.type}; name="${a.name}"`,
      `Content-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${a.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      a.data.toString('base64').replace(/.{76}/g, '$&\r\n'),
    );
  }
  parts.push(`--${b}--`, '');
  return parts.join('\r\n');
}

let h: Harness;
let imap: FakeImap;
let cookie: string;
beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
  imap = new FakeImap();
  (h.ctx.archive() as LocalBackend).mail.clientFactory = (a) => imap.client(a.password);
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;

describe('e-mail intake', () => {
  it('stores attachments once, applies rules and marks or moves the messages', async () => {
    const lib = local().ensureDefaultLibrary();
    const invoice = makePdf([['Rechnung 2024-11 der Stadtwerke']]);
    const u1 = imap.add(message({ from: 'Stadtwerke <rechnung@stadtwerke.example>', subject: 'Ihre Rechnung', attachments: [{ name: 'rechnung.pdf', data: invoice, type: 'application/pdf' }] }));
    const u2 = imap.add(message({ from: 'newsletter@shop.example', subject: 'Angebote', attachments: [{ name: 'flyer.pdf', data: makePdf([['Angebote der Woche']]), type: 'application/pdf' }] }));
    const u3 = imap.add(message({ from: 'Oma <oma@example.com>', subject: 'Fotos', attachments: [{ name: 'logo.png', data: Buffer.from('89504e470d0a1a0a0000', 'hex'), type: 'image/png', inline: true }] }));

    const created = await h.inject({
      method: 'POST',
      url: `/api/libraries/${lib}/intake/mail`,
      headers: { cookie },
      payload: {
        name: 'Familie',
        host: 'imap.example.com',
        username: 'archive@example.com',
        password: 'imap-secret',
        after: 'move',
        afterFolder: 'Archived',
        rules: [
          { from: 'newsletter@', ignore: true },
          { from: 'stadtwerke', tags: ['Strom'], skipAnalysis: true },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const account = created.json() as MailAccountInfo;
    // The password is stored encrypted and never sent back.
    expect(created.body).not.toContain('imap-secret');
    const stored = h.ctx.db.prepare('SELECT password_enc FROM intake_mail_accounts WHERE id = ?').get(account.id) as { password_enc: string };
    expect(stored.password_enc.startsWith('v1:')).toBe(true);
    expect(stored.password_enc).not.toContain('imap-secret');

    const check = await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } });
    expect(check.json()).toMatchObject({ messages: 3, stored: 1, ignored: 1, errors: [] });
    await h.engine.drain();
    await h.workflows.drain();

    const docs = h.ctx.db.prepare("SELECT id, original_filename, source FROM lib_documents WHERE source = 'mail'").all() as { id: number; original_filename: string }[];
    expect(docs.map((d) => d.original_filename)).toEqual(['rechnung.pdf']);
    const meta = h.ctx.metadata(lib);
    await meta.snapshot(true);
    const doc = await h.ctx.backend().getDocument(docs[0].id);
    expect(doc.tags.map((t) => meta.tagName(t))).toEqual(['Strom']);
    expect(h.ctx.repos.documents.get(doc.id)?.status).toBe('skipped'); // stored without analysis
    // The stored message moved, the ignored and the one without a document stayed.
    expect([...imap.folders.get('Archived')!.messages.keys()]).toEqual([u1]);
    expect([...imap.folders.get('INBOX')!.messages.keys()].sort()).toEqual([u2, u3]);

    // Nothing is fetched twice: the next check starts after the last UID.
    const again = await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } });
    expect(again.json()).toMatchObject({ messages: 0, stored: 0 });

    // A rebuilt folder (new UIDVALIDITY) is read again – the intake references prevent duplicates.
    imap.folders.get('Archived')!.messages.delete(u1);
    imap.folders.get('INBOX')!.messages.set(u1, { source: Buffer.from(message({ from: 'Stadtwerke <rechnung@stadtwerke.example>', subject: 'Ihre Rechnung', attachments: [{ name: 'rechnung.pdf', data: invoice, type: 'application/pdf' }] })), flags: new Set() });
    imap.folders.get('INBOX')!.uidValidity = 8;
    await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } });
    expect((h.ctx.db.prepare("SELECT COUNT(*) AS c FROM lib_documents WHERE source = 'mail'").get() as { c: number }).c).toBe(1);
  });

  it('never touches other messages: without UIDPLUS a deletion only flags the message, a move only marks it read', async () => {
    const lib = local().ensureDefaultLibrary();
    imap.caps.clear(); // an old server: neither MOVE nor UIDPLUS
    // Flagged \Deleted by another mail client and not purged yet – a plain EXPUNGE would remove it.
    const other = imap.add(message({ from: 'a@example.com', subject: 'Alt', attachments: [] }), 'INBOX', ['\\Deleted']);
    const u1 = imap.add(message({ from: 'b@example.com', subject: 'Rechnung', attachments: [{ name: 'a.pdf', data: makePdf([['Rechnung Nummer eins']]), type: 'application/pdf' }] }));
    const account = (
      await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/mail`, headers: { cookie }, payload: { name: 'Alt', host: 'h', username: 'u', password: 'imap-secret', after: 'delete' } })
    ).json() as MailAccountInfo;
    expect((await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } })).json()).toMatchObject({ stored: 1, errors: [] });
    const inbox = imap.folders.get('INBOX')!.messages;
    expect([...inbox.keys()].sort()).toEqual([other, u1]);
    expect([...inbox.get(u1)!.flags].sort()).toEqual(['\\Deleted', '\\Seen']);
    expect([...inbox.get(other)!.flags]).toEqual(['\\Deleted']);

    // Moving falls back to marking as read, and the account says why.
    await h.inject({ method: 'PUT', url: `/api/intake/mail/${account.id}`, headers: { cookie }, payload: { name: 'Alt', host: 'h', username: 'u', password: '', after: 'move', afterFolder: 'Archived' } });
    const u2 = imap.add(message({ from: 'c@example.com', subject: 'Brief', attachments: [{ name: 'b.pdf', data: makePdf([['Ein zweiter Brief']]), type: 'application/pdf' }] }));
    const moved = (await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } })).json();
    expect(moved.stored).toBe(1);
    expect(moved.errors[0]).toContain('cannot move');
    expect([...inbox.keys()].sort()).toEqual([other, u1, u2]);
    expect([...inbox.get(u2)!.flags]).toEqual(['\\Seen']);
    expect(imap.folders.get('Archived')!.messages.size).toBe(0);

    // With UIDPLUS the message is deleted – and only that one.
    imap.caps.set('UIDPLUS', true);
    await h.inject({ method: 'PUT', url: `/api/intake/mail/${account.id}`, headers: { cookie }, payload: { name: 'Alt', host: 'h', username: 'u', password: '', after: 'delete' } });
    const u3 = imap.add(message({ from: 'd@example.com', subject: 'Drei', attachments: [{ name: 'c.pdf', data: makePdf([['Das dritte Schreiben']]), type: 'application/pdf' }] }));
    expect((await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } })).json()).toMatchObject({ stored: 1, errors: [] });
    expect(inbox.has(u3)).toBe(false);
    expect([...inbox.keys()].sort()).toEqual([other, u1, u2]);
  });

  it('tells logos, icons and embedded pictures from documents by their size', async () => {
    const att = async (data: Buffer, opts: { related?: boolean; inline?: boolean } = {}) =>
      isMailDecoration({ content: data, size: data.length, related: opts.related ?? false, contentDisposition: opts.inline ? 'inline' : 'attachment' });
    // Decoration: icons, avatars, tracking pixels, banners – also when sent as real attachments (Outlook).
    expect(await att(await image(96, 96))).toBe(true);
    expect(await att(await image(1, 1, 'gif'))).toBe(true);
    expect(await att(await image(600, 200))).toBe(true);
    expect(await att(await image(1200, 180))).toBe(true);
    // Pictures in the HTML text (multipart/related) unless they are as large as a photo or scan.
    expect(await att(await image(1200, 600), { related: true })).toBe(true);
    expect(await att(await image(1240, 1754, 'jpeg'), { related: true })).toBe(false);
    // Documents: attached scans and photos, also phone photos sent "inline".
    expect(await att(await image(1000, 800, 'jpeg'))).toBe(false);
    expect(await att(await image(1280, 960, 'jpeg'), { inline: true })).toBe(false);
    // Unreadable data (no dimensions): small embedded pictures are decoration.
    expect(await att(Buffer.from('89504e470d0a1a0a0000', 'hex'), { inline: true })).toBe(true);
  });

  it('stores the photo of a receipt but not the icons of the mail', async () => {
    const lib = local().ensureDefaultLibrary();
    imap.add(
      message({
        from: 'kim@example.com',
        subject: 'Beleg',
        attachments: [
          { name: 'Unbenannte Anlage 00044.png', data: await image(96, 96), type: 'image/png' },
          { name: 'Unbenannte Anlage 00038.png', data: await image(64, 64), type: 'image/png', inline: true },
          { name: 'IMG_1234.jpg', data: await image(1280, 960, 'jpeg'), type: 'image/jpeg', inline: true },
        ],
      }),
    );
    const account = (await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/mail`, headers: { cookie }, payload: { name: 'K', host: 'h', username: 'u', password: 'imap-secret' } })).json() as MailAccountInfo;
    expect((await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } })).json()).toMatchObject({ stored: 1, errors: [] });
    const docs = h.ctx.db.prepare("SELECT original_filename FROM lib_documents WHERE source = 'mail'").all() as { original_filename: string }[];
    expect(docs.map((d) => d.original_filename)).toEqual(['IMG_1234.jpg']);
  });

  it('checks on the interval from the settings, and a changed interval applies at once', async () => {
    h.ctx.config.update({ archive: { builtin: { mailPollMinutes: 60 } } });
    const mail = local().mail;
    await mail.checkAll();
    const start = Date.now();
    expect(mail.due(start + 30 * 60_000)).toBe(false);
    expect(mail.due(start + 60 * 60_000)).toBe(true);
    h.ctx.config.update({ archive: { builtin: { mailPollMinutes: 5 } } });
    expect(mail.due(start + 4 * 60_000)).toBe(false);
    expect(mail.due(start + 5 * 60_000)).toBe(true);
  });

  it('tests the connection, keeps the password on updates and reports errors on the account', async () => {
    const lib = local().ensureDefaultLibrary();
    const bad = await h.inject({ method: 'POST', url: '/api/intake/mail/test', headers: { cookie }, payload: { host: 'imap.example.com', username: 'x', password: 'wrong' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('Authentication failed');
    const ok = await h.inject({ method: 'POST', url: '/api/intake/mail/test', headers: { cookie }, payload: { host: 'imap.example.com', username: 'x', password: 'imap-secret' } });
    expect(ok.json()).toEqual({ folders: ['INBOX', 'Archived'] });

    const account = (await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/mail`, headers: { cookie }, payload: { name: 'A', host: 'h', username: 'u', password: 'imap-secret' } })).json() as MailAccountInfo;
    const upd = await h.inject({ method: 'PUT', url: `/api/intake/mail/${account.id}`, headers: { cookie }, payload: { name: 'B', host: 'h', username: 'u', password: '' } });
    expect(upd.json().name).toBe('B');
    expect((await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } })).json().errors).toEqual([]);

    // A wrong password is shown on the account.
    await h.inject({ method: 'PUT', url: `/api/intake/mail/${account.id}`, headers: { cookie }, payload: { name: 'B', host: 'h', username: 'u', password: 'nope' } });
    await h.inject({ method: 'POST', url: `/api/intake/mail/${account.id}/check`, headers: { cookie } });
    const list = (await h.inject({ method: 'GET', url: `/api/libraries/${lib}/intake/mail`, headers: { cookie } })).json() as MailAccountInfo[];
    expect(list[0].lastError).toContain('Authentication failed');
  });
});

describe('e-mail intake: failures, only new mails, several libraries', () => {
  const createAccount = async (lib: number, extra: Record<string, unknown> = {}) => {
    const res = await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/mail`, headers: { cookie }, payload: { name: 'M', host: 'h', username: 'u', password: 'imap-secret', after: 'delete', ...extra } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as MailAccountInfo;
  };
  const check = async (id: number) => (await h.inject({ method: 'POST', url: `/api/intake/mail/${id}/check`, headers: { cookie } })).json() as { messages: number; stored: number; errors: string[] };
  const two = (a: Buffer, b: Buffer) =>
    message({
      from: 'x@example.com',
      subject: 'Zwei Anhänge',
      attachments: [
        { name: 'one.pdf', data: a, type: 'application/pdf' },
        { name: 'two.pdf', data: b, type: 'application/pdf' },
      ],
    });

  it('keeps a message whose attachment failed and reads it again next time', async () => {
    const lib = local().ensureDefaultLibrary();
    const uid = imap.add(two(makePdf([['Erster Anhang']]), makePdf([['Zweiter Anhang']])));
    const account = await createAccount(lib);
    // The second attachment fails for a passing reason (e.g. the disk was full).
    const refresh = local().refreshFts.bind(local());
    let failed = false;
    local().refreshFts = (id: number) => {
      if (!failed && local().row(id)?.original_filename === 'two.pdf') {
        failed = true;
        throw new Error('disk full');
      }
      refresh(id);
    };
    const first = await check(account.id);
    local().refreshFts = refresh;
    expect(first.errors[0]).toMatch(/two\.pdf.*could not be stored/);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS c FROM lib_documents WHERE source = 'mail'").get()).toEqual({ c: 1 });
    expect(imap.folders.get('INBOX')!.messages.has(uid)).toBe(true); // not deleted
    // Next check: the message is read again, the first attachment is not stored twice.
    const second = await check(account.id);
    expect(second.errors).toEqual([]);
    expect(imap.folders.get('INBOX')!.messages.has(uid)).toBe(false);
    const files = (h.ctx.db.prepare("SELECT original_filename FROM lib_documents WHERE source = 'mail' ORDER BY original_filename").all() as { original_filename: string }[]).map((d) => d.original_filename);
    expect(files).toEqual(['one.pdf', 'two.pdf']);
  });

  it('leaves a message with a refused attachment in the mailbox', async () => {
    const lib = local().ensureDefaultLibrary();
    h.ctx.config.update({ archive: { builtin: { maxUploadMb: 1 } } });
    const tooLarge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_200_000, 32)]);
    const uid = imap.add(two(makePdf([['Kleiner Anhang']]), tooLarge));
    const account = await createAccount(lib);
    const res = await check(account.id);
    expect(res.stored).toBe(1);
    expect(res.errors[0]).toMatch(/two\.pdf.*refused.*left in the mailbox/);
    const msg = imap.folders.get('INBOX')!.messages.get(uid)!;
    expect(msg).toBeDefined();
    expect([...msg.flags]).toEqual([]); // untouched: still unread
    expect((h.ctx.db.prepare('SELECT last_error FROM intake_mail_accounts WHERE id = ?').get(account.id) as { last_error: string }).last_error).toMatch(/left in the mailbox/);
  });

  it('reads only messages that arrive later with "only new e-mails"', async () => {
    const lib = local().ensureDefaultLibrary();
    const old = imap.add(message({ from: 'a@example.com', subject: 'Alt', attachments: [{ name: 'old.pdf', data: makePdf([['Alte Rechnung']]), type: 'application/pdf' }] }));
    const account = await createAccount(lib, { skipExisting: true });
    expect(account.skipExisting).toBe(true);
    expect(await check(account.id)).toMatchObject({ messages: 0, stored: 0 });
    expect(imap.folders.get('INBOX')!.messages.has(old)).toBe(true);
    imap.add(message({ from: 'a@example.com', subject: 'Neu', attachments: [{ name: 'new.pdf', data: makePdf([['Neue Rechnung']]), type: 'application/pdf' }] }));
    expect(await check(account.id)).toMatchObject({ messages: 1, stored: 1 });
    const files = (h.ctx.db.prepare("SELECT original_filename FROM lib_documents WHERE source = 'mail'").all() as { original_filename: string }[]).map((d) => d.original_filename);
    expect(files).toEqual(['new.pdf']);
  });

  it('sends messages to other libraries by rule, with one account per mailbox', async () => {
    const lib = local().ensureDefaultLibrary();
    const family = (await h.inject({ method: 'POST', url: '/api/libraries', headers: { cookie }, payload: { name: 'Family' } })).json() as { id: number };
    imap.add(message({ from: 'kita@example.com', subject: 'Elternbrief', attachments: [{ name: 'kita.pdf', data: makePdf([['Elternbrief der Kita']]), type: 'application/pdf' }] }));
    imap.add(message({ from: 'shop@example.com', subject: 'Rechnung', attachments: [{ name: 'shop.pdf', data: makePdf([['Rechnung vom Shop']]), type: 'application/pdf' }] }));
    const account = await createAccount(lib, { after: 'seen', rules: [{ from: 'kita@', libraryId: family.id }] });
    expect(account.rules[0].libraryId).toBe(family.id);
    expect(await check(account.id)).toMatchObject({ stored: 2, errors: [] });
    const rows = h.ctx.db.prepare("SELECT original_filename AS file, library_id FROM lib_documents WHERE source = 'mail' ORDER BY original_filename").all();
    expect(rows).toEqual([
      { file: 'kita.pdf', library_id: family.id },
      { file: 'shop.pdf', library_id: lib },
    ]);
    // A second account on the same mailbox would take the messages away from the first one.
    const dup = await h.inject({ method: 'POST', url: `/api/libraries/${family.id}/intake/mail`, headers: { cookie }, payload: { name: 'Dup', host: 'H', username: 'U', password: 'imap-secret' } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toMatch(/connected already/);
    // A rule naming a library that does not exist is refused.
    const bad = await h.inject({ method: 'PUT', url: `/api/intake/mail/${account.id}`, headers: { cookie }, payload: { name: 'M', host: 'h', username: 'u', rules: [{ from: 'x', libraryId: 999 }] } });
    expect(bad.statusCode).toBe(400);
  });
});
