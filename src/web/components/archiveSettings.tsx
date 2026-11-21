/**
 * Settings → Archive (built-in archive): storage, intake limits, trash, and the health of the store.
 */
import { useState } from 'react';
import { Archive, Download, HardDrive, Mail, ShieldCheck, Wrench } from 'lucide-react';
import { Alert, Badge, Button, Card, Field, Input, NumberInput, Select, Skeleton, Switch, useToast } from './ui';
import type { Config, Locked } from './settingsForms';
import type { ExportResult } from '@shared/migration';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';

interface ArchiveStatus {
  storageDir: string;
  storeId: string;
  documents: number;
  trash: number;
  files: { c: number; bytes: number };
  libraries: number;
  quickCheck: string | null;
  quickCheckAt: number | null;
  corruptFiles: string[];
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function ArchiveSection({ draft, set, locked }: { draft: Config; set: (path: string, value: unknown) => void; locked: Locked }) {
  const toast = useToast();
  const b = draft.archive.builtin;
  const status = useAsync((signal) => get<ArchiveStatus>('/api/archive/status', signal), []);
  const [running, setRunning] = useState(false);
  const runMaintenance = async () => {
    setRunning(true);
    try {
      const r = await post<{ purged: number; blobsRemoved: number; orphanFiles: number; verified: number; corrupt: string[] }>('/api/archive/maintenance');
      toast.success(`Maintenance done: ${r.purged} purged, ${r.blobsRemoved + r.orphanFiles} file(s) cleaned up, ${r.verified} verified`);
      if (r.corrupt.length) toast.error(`${r.corrupt.length} file(s) are missing or damaged`);
      await status.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };
  const s = status.data;
  return (
    <div className="space-y-6">
      <Card title="Storage" icon={<HardDrive className="size-4" />} description="The database stays in data/; the files can live on a separate (large) disk.">
        <div className="space-y-4">
          <Field label="File storage" hint="Empty: data/library. Changing it does not move existing files – copy them over first." locked={locked['archive.builtin.storageDir']}>
            <Input value={b.storageDir} onChange={(e) => set('archive.builtin.storageDir', e.target.value)} placeholder="data/library" disabled={Boolean(locked['archive.builtin.storageDir'])} />
          </Field>
          <Field label="Largest file (MB)" locked={locked['archive.builtin.maxUploadMb']}>
            <NumberInput value={b.maxUploadMb} min={1} max={4096} onChange={(v) => set('archive.builtin.maxUploadMb', v)} disabled={Boolean(locked['archive.builtin.maxUploadMb'])} />
          </Field>
          <Field label="Days in the trash" hint="Default for new libraries; each library can have its own.">
            <NumberInput value={b.trashDays} min={1} max={3650} onChange={(v) => set('archive.builtin.trashDays', v)} />
          </Field>
          <Switch checked={b.membersCreateLibraries} onChange={(v) => set('archive.builtin.membersCreateLibraries', v)} label="Members may create libraries" description="Otherwise only administrators can." />
        </div>
      </Card>

      <Card title="Watch folder" icon={<Archive className="size-4" />} description="Files dropped into this folder – by a scanner, an SMB/FTP share or by hand – are imported. Libraries can have folders of their own.">
        <div className="space-y-4">
          <Field label="Folder" hint="Empty: off. Subfolders become tags (e.g. /consume/Taxes/scan.pdf → tag “Taxes”)." locked={locked['archive.builtin.consumeDir']}>
            <Input value={b.consumeDir} onChange={(e) => set('archive.builtin.consumeDir', e.target.value)} placeholder="/consume" disabled={Boolean(locked['archive.builtin.consumeDir'])} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Check every (seconds)">
              <NumberInput value={b.consumePollSeconds} min={2} max={3600} onChange={(v) => set('archive.builtin.consumePollSeconds', v)} />
            </Field>
            <Field label="Afterwards">
              <Select value={b.consumeAfter} onChange={(e) => set('archive.builtin.consumeAfter', e.target.value)}>
                <option value="delete">Delete the file</option>
                <option value="move">Move it to .done/</option>
              </Select>
            </Field>
          </div>
          <Switch checked={b.webdav} onChange={(v) => set('archive.builtin.webdav', v)} label="WebDAV inbox" description="Scanners and apps can save to /dav/inbox/ (user name + an API key with the upload permission)." />
          <Field
            label="Check e-mail accounts every (minutes)"
            hint="The accounts are set up per library (Libraries → E-mail). New documents are analysed as soon as they arrive."
            locked={locked['archive.builtin.mailPollMinutes']}
            className="sm:max-w-xs"
          >
            <NumberInput value={b.mailPollMinutes} min={1} max={1440} disabled={Boolean(locked['archive.builtin.mailPollMinutes'])} onChange={(v) => set('archive.builtin.mailPollMinutes', v)} />
          </Field>
        </div>
      </Card>

      <ExportCard />

      <Card
        title="Health"
        icon={<ShieldCheck className="size-4" />}
        actions={
          <Button size="sm" icon={<Wrench className="size-4" />} loading={running} onClick={runMaintenance}>
            Run maintenance now
          </Button>
        }
      >
        {status.error && <Alert tone="danger">{status.error}</Alert>}
        {!s ? (
          <Skeleton className="h-20" />
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted">Documents</div>
                <div className="font-semibold">{formatNumber(s.documents)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">In the trash</div>
                <div className="font-semibold">{formatNumber(s.trash)}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Files</div>
                <div className="font-semibold">
                  {formatNumber(s.files.c)} · {bytes(s.files.bytes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Libraries</div>
                <div className="font-semibold">{formatNumber(s.libraries)}</div>
              </div>
            </div>
            <div className="text-xs text-muted">
              Store: <code>{s.storageDir}</code> · id {s.storeId.slice(0, 8)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              Database check:{' '}
              {s.quickCheck === null ? <Badge>not run yet</Badge> : s.quickCheck === 'ok' ? <Badge tone="success">ok</Badge> : <Badge tone="danger">{s.quickCheck}</Badge>}
              {s.quickCheckAt && <span className="text-xs text-muted">{formatDate(s.quickCheckAt, true)}</span>}
            </div>
            {s.corruptFiles.length > 0 && <Alert tone="danger">{s.corruptFiles.length} file(s) are missing or damaged – restore them from your backup.</Alert>}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Settings → Notifications: the mail server for workflow e-mails. */
export function NotificationsSection({ draft, set, locked, dirty }: { draft: Config; set: (path: string, value: unknown) => void; locked: Locked; dirty: boolean }) {
  const toast = useToast();
  const s = draft.notifications.smtp;
  const [testing, setTesting] = useState(false);
  const field = (key: keyof Config['notifications']['smtp']) => `notifications.smtp.${key}`;
  const test = async () => {
    setTesting(true);
    try {
      await post('/api/settings/test-smtp');
      toast.success('The mail server accepted the connection');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card
      title="E-mail"
      icon={<Mail className="size-4" />}
      description="Workflows can send e-mails (action “Send an e-mail”). Recipients only hear about documents they may read."
      actions={
        <Button size="sm" loading={testing} disabled={dirty || !s.host} onClick={() => void test()} title={dirty ? 'Save first' : undefined}>
          Test connection
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mail server (SMTP)" locked={locked[field('host')]}>
          <Input value={s.host} placeholder="smtp.example.com" disabled={Boolean(locked[field('host')])} onChange={(e) => set(field('host'), e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port" locked={locked[field('port')]}>
            <NumberInput value={s.port} min={1} max={65535} disabled={Boolean(locked[field('port')])} onChange={(v) => set(field('port'), v)} />
          </Field>
          <Field label="Security" locked={locked[field('security')]}>
            <Select value={s.security} disabled={Boolean(locked[field('security')])} onChange={(e) => set(field('security'), e.target.value)}>
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">none (local relay)</option>
            </Select>
          </Field>
        </div>
        <Field label="User name" locked={locked[field('username')]}>
          <Input value={s.username} autoComplete="off" disabled={Boolean(locked[field('username')])} onChange={(e) => set(field('username'), e.target.value)} />
        </Field>
        <Field label="Password" locked={locked[field('password')]}>
          <Input type="password" autoComplete="new-password" value={s.password} disabled={Boolean(locked[field('password')])} onChange={(e) => set(field('password'), e.target.value)} />
        </Field>
        <Field label="Sender" hint="e.g. Paperless-AI <archive@example.com>" className="sm:col-span-2" locked={locked[field('from')]}>
          <Input value={s.from} disabled={Boolean(locked[field('from')])} onChange={(e) => set(field('from'), e.target.value)} />
        </Field>
      </div>
    </Card>
  );
}

function ExportCard() {
  const toast = useToast();
  const [format, setFormat] = useState<'ngx' | 'plain'>('plain');
  const [directory, setDirectory] = useState('');
  const [checksums, setChecksums] = useState<'sha256' | 'md5'>('sha256');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<ExportResult>('/api/archive/export', { format, directory: directory.trim() || undefined, checksums });
      setResult(r);
      toast.success(`${r.documents} document(s) exported`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Export" icon={<Download className="size-4" />} description="Your documents are never locked in: export them as plain folders or for Paperless-ngx (document_importer).">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Format">
            <Select value={format} onChange={(e) => setFormat(e.target.value as 'ngx' | 'plain')}>
              <option value="plain">Folders library/correspondent/year + metadata.json/.csv</option>
              <option value="ngx">Paperless-ngx (document_importer)</option>
            </Select>
          </Field>
          <Field label="Directory on the server" hint="Empty: data/exports/<format>-<time>. Must be empty.">
            <Input value={directory} placeholder="/exports/archive" onChange={(e) => setDirectory(e.target.value)} />
          </Field>
          {format === 'ngx' && (
            <Field label="Checksums" hint="As the target Paperless-ngx computes them – its sanity check compares them with the files.">
              <Select value={checksums} onChange={(e) => setChecksums(e.target.value as 'sha256' | 'md5')}>
                <option value="sha256">SHA-256 (current Paperless-ngx)</option>
                <option value="md5">MD5 (older Paperless-ngx)</option>
              </Select>
            </Field>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={busy} onClick={() => void run()}>
            Export now
          </Button>
          <a className="text-sm text-accent hover:underline" href="/migration">
            Migration from Paperless-ngx
          </a>
        </div>
        {result && (
          <Alert tone="success">
            {result.documents} document(s), {result.files} file(s), {bytes(result.bytes)} in <code>{result.directory}</code>
          </Alert>
        )}
      </div>
    </Card>
  );
}
