/**
 * Migration assistant: Paperless-ngx → built-in archive (administrators). Paperless-ngx is only read
 * until the switch; the import can be repeated (sync) as often as needed.
 */
import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Database, Pause, Play, RefreshCw, Search, Trash2, Undo2, Users } from 'lucide-react';
import type { MigrationOptions, MigrationPlan, MigrationReport, MigrationRule, MigrationStatus, MigrationStrategy } from '@shared/migration';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, Field, IconButton, Input, NumberInput, PageHeader, Segmented, Skeleton, Switch, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { formatDate, formatNumber } from '../lib/format';
import { useSession } from '../lib/session';

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export default function MigrationPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useSession();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<MigrationStrategy['kind']>('single');
  const [single, setSingle] = useState('Archive');
  const [shared, setShared] = useState('Shared');
  const [rules, setRules] = useState<MigrationRule[]>([]);
  const [fallback, setFallback] = useState('Archive');
  const [options, setOptions] = useState<MigrationOptions>({ archived: false, createUsers: true, concurrency: 4 });
  const strategy: MigrationStrategy = kind === 'single' ? { kind, libraryName: single } : kind === 'owner' ? { kind, sharedName: shared } : { kind, rules, defaultLibrary: fallback };

  const load = async () => setStatus(await get<MigrationStatus>('/api/migration/status'));
  useEffect(() => {
    void load();
  }, []);
  // While the import runs, the progress is polled.
  useEffect(() => {
    if (!status?.running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [status?.running]);

  const run = async <T,>(name: string, fn: () => Promise<T>, done?: (r: T) => string | null) => {
    setBusy(name);
    try {
      const r = await fn();
      const msg = done?.(r);
      if (msg) toast.success(msg);
      await load();
      return r;
    } catch (err) {
      toast.error(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const s = status;
  const started = Boolean(s && s.counts.total > 0);
  const switched = s?.state === 'cutover' || s?.mode === 'builtin';
  /** Switched by this assistant (not an installation that started with the built-in archive). */
  const cutover = s?.state === 'cutover';
  // Documents added in the built-in archive itself: the import (same ids as Paperless-ngx) cannot run next to them.
  const blocked = Boolean(s && s.ownDocuments > 0);
  const progress = s && s.counts.total ? Math.round(((s.counts.imported + s.counts.failed + s.counts.skipped + s.counts.deleted) / s.counts.total) * 100) : 0;

  return (
    <Page>
      <PageHeader
        title="Move to the built-in archive"
        description="Paperless-AI copies your documents from Paperless-ngx into its own archive – with the same ids, so the AI history, OCR results, the calendar and “Ask your archive” stay as they are. Paperless-ngx is only read until you switch."
      />
      {!s ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <div className="space-y-5">
          {blocked && (
            <Alert tone="warn" title={`The built-in archive has ${formatNumber(s.ownDocuments)} document(s) of its own`}>
              The import keeps the document ids of Paperless-ngx, so the AI history, OCR results and “Ask your archive” stay valid – next to documents added here it would
              collide with their ids. Run it from companion mode (Paperless-AI connected to Paperless-ngx) in a new installation, or empty the built-in archive first.
            </Alert>
          )}
          {cutover && (
            <Alert tone="success" title="The built-in archive is in use">
              Switched {s.cutoverAt ? formatDate(s.cutoverAt, true) : ''}. Keep Paperless-ngx (read-only) for a while before you shut it down – switching back is possible as long as it exists.
            </Alert>
          )}

          <Card title="1. Analyse" icon={<Search className="size-4" />} description="What is in Paperless-ngx, how much space it needs and what cannot be moved." actions={
            <Button size="sm" loading={busy === 'analyse'} onClick={() => void run('analyse', () => post<MigrationReport>('/api/migration/analyse'), (r) => (setReport(r), null))}>
              Analyse
            </Button>
          }>
            {!report ? (
              <p className="text-sm text-muted">Nothing is changed – this only reads Paperless-ngx.</p>
            ) : (
              <div className="space-y-4 text-sm">
                {!report.superuser && <Alert tone="warn">The token is not a superuser: only the documents it can see are moved.</Alert>}
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(
                    [
                      ['Documents', report.counts.documents],
                      ['Pages', report.counts.pages],
                      ['Tags', report.counts.tags],
                      ['Correspondents', report.counts.correspondents],
                      ['Document types', report.counts.documentTypes],
                      ['Custom fields', report.counts.customFields],
                      ['Users', report.counts.users ?? '–'],
                      ['Groups', report.counts.groups ?? '–'],
                    ] as [string, number | string][]
                  ).map(([l, v]) => (
                    <div key={l} className="rounded-xl bg-surface-2 px-3 py-2 ring-1 ring-border">
                      <dd className="font-semibold tabular-nums">{typeof v === 'number' ? formatNumber(v) : v}</dd>
                      <dt className="text-xs text-muted">{l}</dt>
                    </div>
                  ))}
                </dl>
                <p>
                  Space needed: about <strong>{bytes(report.storage.estimatedBytes)}</strong>
                  {report.storage.freeBytes !== null && <> – {bytes(report.storage.freeBytes)} free</>}
                  {report.storage.freeBytes !== null && report.storage.freeBytes < report.storage.estimatedBytes * 1.2 && <Badge tone="danger" className="ml-2">not enough</Badge>}
                </p>
                <div>
                  <div className="font-medium">Not moved</div>
                  <ul className="mt-1 list-disc pl-5 text-muted">
                    <li>{report.notTransferred.workflows ?? '?'} Paperless-ngx workflows and {report.notTransferred.matchingRules} matching rules – rebuild them as workflows here</li>
                    <li>{report.notTransferred.mailAccounts ?? '?'} mail accounts, {report.notTransferred.mailRules ?? '?'} mail rules – set them up under Libraries → E-mail</li>
                    <li>{report.notTransferred.savedViews ?? '?'} saved views, {report.notTransferred.shareLinks ?? '?'} share links</li>
                    <li>{report.notTransferred.notes} notes – kept in data/migration/notes.json</li>
                  </ul>
                </div>
                {report.fieldProblems.length > 0 && (
                  <Alert tone="warn" title={`${report.fieldProblems.length} custom field value(s) do not fit their type – they are kept as text`}>
                    {report.fieldProblems.slice(0, 5).map((p) => `#${p.documentId} ${p.field}: “${p.value}”`).join(' · ')}
                  </Alert>
                )}
              </div>
            )}
          </Card>

          <Card title="2. Libraries and people" icon={<Users className="size-4" />} description="Paperless-ngx has permissions per document; libraries are coarser on purpose. Check who will see what before importing.">
            <div className="space-y-4">
              <Segmented
                label="Strategy"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'single', label: 'One library' },
                  { value: 'owner', label: 'A library per owner' },
                  { value: 'rules', label: 'Rules' },
                ]}
              />
              {kind === 'single' && (
                <Field label="Library" hint="Everyone gets access – admins as owners, the others as editors.">
                  <Input value={single} onChange={(e) => setSingle(e.target.value)} />
                </Field>
              )}
              {kind === 'owner' && (
                <Field label="Library for documents without owner" hint="Each owner gets their library; people with permissions on their documents become viewers or editors.">
                  <Input value={shared} onChange={(e) => setShared(e.target.value)} />
                </Field>
              )}
              {kind === 'rules' && (
                <div className="space-y-2">
                  {rules.map((r, i) => (
                    <div key={i} className="grid gap-2 rounded-lg bg-surface-2 p-2 ring-1 ring-border sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                      <Input aria-label="Owner" placeholder="Owner (user name)" value={r.owner ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, owner: e.target.value || undefined } : x)))} />
                      <Input aria-label="Tag" placeholder="Tag" value={r.tag ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, tag: e.target.value || undefined } : x)))} />
                      <Input aria-label="Storage path" placeholder="Storage path" value={r.storagePath ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, storagePath: e.target.value || undefined } : x)))} />
                      <Input aria-label="Library" placeholder="→ Library" value={r.library} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, library: e.target.value } : x)))} />
                      <IconButton label="Remove rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => setRules([...rules, { library: '' }])}>
                    Add rule
                  </Button>
                  <Field label="Everything else goes to">
                    <Input value={fallback} onChange={(e) => setFallback(e.target.value)} />
                  </Field>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-3">
                <Switch checked={options.archived} onChange={(archived) => setOptions({ ...options, archived })} label="Archived PDFs too" description="Paperless-ngx’s OCR’d PDF/A (more space; the text is imported anyway)." />
                <Switch checked={options.createUsers} onChange={(createUsers) => setOptions({ ...options, createUsers })} label="Create missing accounts" description="Disabled, without password – activate them or link them to single sign-on." />
                <Field label="Documents at the same time">
                  <NumberInput min={1} max={16} value={options.concurrency} onChange={(concurrency) => setOptions({ ...options, concurrency })} />
                </Field>
              </div>
              <Button loading={busy === 'plan'} disabled={started && !switched && s.state !== 'idle'} onClick={() => void run('plan', () => post<MigrationPlan>('/api/migration/plan', { strategy, options }), (p) => (setPlan(p), null))}>
                Show who will see what
              </Button>
              {plan && (
                <div className="space-y-3">
                  <div className="overflow-x-auto rounded-xl border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-2 text-left text-xs text-muted">
                        <tr>
                          <th className="px-3 py-2">Library</th>
                          <th className="px-3 py-2">Documents</th>
                          <th className="px-3 py-2">Members</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {plan.libraries.map((l) => (
                          <tr key={l.name}>
                            <td className="px-3 py-2 font-medium">{l.name}</td>
                            <td className="px-3 py-2 tabular-nums">{formatNumber(l.documents)}</td>
                            <td className="px-3 py-2">{l.members.map((m) => `${m.user} (${m.role})`).join(', ') || '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted">
                    Accounts: {plan.users.map((u) => `${u.ngx} → ${u.action === 'match' ? u.local : u.action === 'create' ? 'new (disabled)' : 'not moved'}`).join(' · ') || 'none readable with this token'}. Administrators of
                    Paperless-AI become owners of every library.
                  </p>
                  {plan.widened.length > 0 && (
                    <Alert tone="warn" title="Some people would see more than in Paperless-ngx">
                      {plan.widened.map((w) => `${w.user}: ${w.documents} more document(s) in “${w.library}”`).join(' · ')}. Use rules to put those documents into a separate library if that is not wanted.
                    </Alert>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card title="3. Import" icon={<Database className="size-4" />} description="Documents are copied one by one; you can pause and continue at any time. Errors do not stop the import.">
            <div className="space-y-3">
              {started && (
                <>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
                    <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-sm">
                    {formatNumber(s.counts.imported)} of {formatNumber(s.counts.total)} imported
                    {s.counts.failed ? `, ${s.counts.failed} failed` : ''}
                    {s.counts.deleted ? `, ${s.counts.deleted} deleted in Paperless-ngx` : ''} · {s.running ? 'running' : s.state}
                    {s.lastSyncAt ? ` · last sync ${formatDate(s.lastSyncAt, true)}` : ''}
                  </p>
                  {s.errors.length > 0 && <Alert tone="danger">{s.errors.slice(0, 5).map((e) => `#${e.id}: ${e.error}`).join(' · ')}</Alert>}
                </>
              )}
              <div className="flex flex-wrap gap-2">
                {!started && (
                  <Button variant="primary" icon={<Play className="size-4" />} disabled={!plan || blocked} loading={busy === 'start'} onClick={() => void run('start', () => post('/api/migration/start', { strategy, options }), () => 'Import started')}>
                    Start the import
                  </Button>
                )}
                {s.running && (
                  <Button icon={<Pause className="size-4" />} onClick={() => void run('pause', () => post('/api/migration/pause'))}>
                    Pause
                  </Button>
                )}
                {started && !s.running && (s.state === 'paused' || s.state === 'failed') && (
                  <Button icon={<Play className="size-4" />} onClick={() => void run('resume', () => post('/api/migration/resume'))}>
                    Continue
                  </Button>
                )}
                {started && !s.running && (
                  <Button icon={<RefreshCw className="size-4" />} loading={busy === 'sync'} onClick={() => void run('sync', () => post<{ added: number; updated: number; deleted: number }>('/api/migration/sync'), (r) => `${r.added} new, ${r.updated} changed, ${r.deleted} deleted`)}>
                    Sync changes from Paperless-ngx
                  </Button>
                )}
                {started && !switched && !s.running && (
                  <Button
                    variant="ghost"
                    icon={<Trash2 className="size-4" />}
                    onClick={async () => {
                      if (!(await confirm({ title: 'Discard the import?', message: 'All imported documents and files are removed from the built-in archive. Paperless-ngx is not affected.', confirmLabel: 'Discard', danger: true }))) return;
                      await run('discard', () => post('/api/migration/discard'), () => 'Import discarded');
                      setPlan(null);
                    }}
                  >
                    Discard
                  </Button>
                )}
              </div>
            </div>
          </Card>

          <Card title="4. Switch" icon={<ArrowRightLeft className="size-4" />} description="Processing pauses, a last sync runs, then Paperless-AI uses the built-in archive.">
            {switched ? (
              <div className="flex flex-wrap items-center gap-3">
                <CheckCircle2 className="size-5 text-success" />
                <span className="text-sm">The built-in archive is in use.</span>
                {cutover && (
                  <Button
                    variant="ghost"
                    icon={<Undo2 className="size-4" />}
                    onClick={async () => {
                      if (!(await confirm({ title: 'Switch back to Paperless-ngx?', message: 'Changes made in the built-in archive since the switch are not in Paperless-ngx.', confirmLabel: 'Switch back', danger: true }))) return;
                      await run('rollback', () => post<{ changes: number }>('/api/migration/rollback'), (r) => `Back on Paperless-ngx – ${r.changes} change(s) since the switch stay in the built-in archive`);
                      await refresh();
                    }}
                  >
                    Switch back
                  </Button>
                )}
              </div>
            ) : (
              <Button
                variant="primary"
                disabled={!started || s.running || s.counts.imported === 0}
                loading={busy === 'cutover'}
                onClick={async () => {
                  if (!(await confirm({ title: 'Switch to the built-in archive?', message: 'From now on documents are stored and changed in Paperless-AI. Paperless-ngx stays as it is.', confirmLabel: 'Switch' }))) return;
                  await run('cutover', () => post('/api/migration/cutover'), () => 'The built-in archive is in use now');
                  await refresh();
                }}
              >
                Switch to the built-in archive
              </Button>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
