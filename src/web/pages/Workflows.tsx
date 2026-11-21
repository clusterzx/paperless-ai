/**
 * Workflows: the list (order, on/off, last runs, warnings) and the editor with dry run and run log.
 * /workflows, /workflows/new, /workflows/:id
 */
import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import type { LibraryInfo } from '@shared/api';
import type { Workflow } from '@shared/workflows';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, EmptyState, IconButton, PageHeader, Skeleton, Switch, Tabs, tabPanelProps, useToast } from '../components/ui';
import { RunLog, triggerSummary, TRIGGER_LABELS, WorkflowEditor } from '../components/workflowEditor';
import { errorMessage, get, patch, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

function WorkflowList() {
  const toast = useToast();
  const { session } = useSession();
  const admin = session?.user?.role === 'admin';
  const builtin = Boolean(session?.archive?.capabilities.libraries);
  const list = useAsync((signal) => get<Workflow[]>('/api/workflows', signal), []);
  const libraries = useAsync((signal) => (builtin ? get<LibraryInfo[]>('/api/libraries', signal) : Promise.resolve([] as LibraryInfo[])), [builtin]);
  const libName = (id: number | null) => (id === null ? null : (libraries.data?.find((l) => l.id === id)?.name ?? `#${id}`));
  const canEdit = (w: Workflow) => !w.locked && (admin || (w.libraryId !== null && libraries.data?.find((l) => l.id === w.libraryId)?.role === 'owner'));
  const workflows = list.data ?? [];

  const toggle = async (w: Workflow, enabled: boolean) => {
    try {
      await patch(`/api/workflows/${w.id}`, { enabled });
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const move = async (i: number, d: -1 | 1) => {
    const ids = workflows.filter((w) => w.id > 0).map((w) => w.id);
    const a = ids.indexOf(workflows[i].id);
    const b = ids.indexOf(workflows[i + d].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    try {
      await post('/api/workflows/order', { ids });
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Workflows"
        description="When something happens, if the document matches, then do something – with the AI where it helps. Every run is logged; a test shows what would change."
        actions={
          (admin || libraries.data?.some((l) => l.role === 'owner')) && (
            <Link href="/workflows/new">
              <Button variant="primary" icon={<Plus className="size-4" />}>
                New workflow
              </Button>
            </Link>
          )
        }
      />
      {list.error && <Alert tone="danger">{list.error}</Alert>}
      {!list.data ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : workflows.length === 0 ? (
        <EmptyState icon={<WorkflowIcon className="size-6" />} title="No workflows yet">
          Prompt rules are workflows that run before the analysis – they appear here as well.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {workflows.map((w, i) => (
            <li key={w.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', !w.enabled && 'opacity-70')}>
              <div className="flex flex-col">
                <IconButton label={`Move ${w.name} up`} disabled={!canEdit(w) || i === 0 || workflows[i - 1].id < 0} onClick={() => void move(i, -1)}>
                  <ArrowUp className="size-3.5" />
                </IconButton>
                <IconButton label={`Move ${w.name} down`} disabled={!canEdit(w) || i === workflows.length - 1} onClick={() => void move(i, 1)}>
                  <ArrowDown className="size-3.5" />
                </IconButton>
              </div>
              <Link href={`/workflows/${w.id}`} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg hover:underline">{w.name}</span>
                  {w.locked && <Badge>PROMPT_RULES</Badge>}
                  {builtin && <Badge tone={w.libraryId === null ? 'accent' : 'neutral'}>{libName(w.libraryId) ?? 'all libraries'}</Badge>}
                  {w.suspendedReason && (
                    <Badge tone="warn" title={w.suspendedReason}>
                      <AlertTriangle className="mr-1 size-3" /> suspended
                    </Badge>
                  )}
                  {w.stats?.rateLimited && <Badge tone="warn">rate limited</Badge>}
                  {Boolean(w.stats?.failed7d) && <Badge tone="danger">{w.stats!.failed7d} failed</Badge>}
                </div>
                <div className="text-xs text-muted">
                  {triggerSummary(w.trigger)} · {w.conditions.items.length} condition{w.conditions.items.length === 1 ? '' : 's'} · {w.actions.length} action{w.actions.length === 1 ? '' : 's'}
                  {w.stats ? ` · ${w.stats.runs7d} run${w.stats.runs7d === 1 ? '' : 's'} in 7 days` : ''}
                  {w.stats?.lastRun ? ` · last ${timeAgo(w.stats.lastRun.at)} (${w.stats.lastRun.status.replace('_', ' ')})` : ''}
                </div>
              </Link>
              {canEdit(w) && <Switch checked={w.enabled} onChange={(v) => void toggle(w, v)} label={<span className="sr-only">Enabled</span>} />}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-faint">
        Triggers: {Object.values(TRIGGER_LABELS).join(' · ')}. Workflows of the same trigger run in the order of this list.
      </p>
    </Page>
  );
}

function WorkflowPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const isNew = id === 'new';
  const wf = useAsync((signal) => (isNew ? Promise.resolve(null) : get<Workflow>(`/api/workflows/${id}`, signal)), [id]);
  const [tab, setTab] = useState<'edit' | 'runs'>('edit');
  const locked = useAsync((signal) => (!isNew && Number(id) < 0 ? get<Workflow[]>('/api/workflows', signal).then((l) => l.find((w) => w.id === Number(id)) ?? null) : Promise.resolve(null)), [id]);
  const initial = Number(id) < 0 ? locked.data : wf.data;
  return (
    <Page wide>
      <PageHeader title={isNew ? 'New workflow' : (initial?.name ?? 'Workflow')} eyebrow={<Link href="/workflows">Workflows</Link>} />
      {wf.error && Number(id) > 0 && <Alert tone="danger">{wf.error}</Alert>}
      {!isNew && (
        <Tabs
          id="workflow"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'edit', label: 'Workflow' },
            { id: 'runs', label: 'Runs' },
          ]}
        />
      )}
      <div className="mt-5" {...tabPanelProps('workflow', tab)}>
        {!isNew && !initial ? (
          <Skeleton className="h-96 rounded-2xl" />
        ) : tab === 'edit' || isNew ? (
          <WorkflowEditor key={initial?.id ?? 'new'} initial={initial ?? null} onSaved={(w) => (isNew ? navigate(`/workflows/${w.id}`) : void wf.reload())} onDeleted={() => navigate('/workflows')} />
        ) : (
          <RunLog workflowId={Number(id)} />
        )}
      </div>
    </Page>
  );
}

export default function WorkflowsPage() {
  const params = useParams<{ id?: string }>();
  return params.id ? <WorkflowPage id={params.id} /> : <WorkflowList />;
}
