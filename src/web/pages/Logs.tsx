import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bug, Download, Pause, Play, Plug, Search, Stethoscope, Trash2 } from 'lucide-react';
import type { ConnectionTestResult, LogEntryDto, SessionInfo } from '@shared/api';
import { Page } from '../components/Layout';
import { TestResult } from '../components/settingsForms';
import { Alert, Badge, Button, Card, Input, PageHeader, Select, Tabs, tabPanelProps } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { cn } from '../lib/format';
import { useSession } from '../lib/session';

const LEVEL_TONE: Record<string, string> = {
  trace: 'text-faint',
  debug: 'text-info',
  info: 'text-success',
  warn: 'text-warn',
  error: 'text-danger',
  fatal: 'text-danger',
};
const LEVELS = ['debug', 'info', 'warn', 'error'];
/** Entries kept in memory (also while paused). */
const MAX_ENTRIES = 2000;

function formatEntry(e: LogEntryDto): string {
  const err = (e.data?.err as { message?: string } | undefined)?.message;
  return `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.module ? `[${e.module}] ` : ''}${e.msg}${err ? ` — ${err}` : ''}`;
}

function LiveLogs() {
  const { refresh } = useSession();
  const [entries, setEntries] = useState<LogEntryDto[]>([]);
  const [level, setLevel] = useState('info');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const box = useRef<HTMLDivElement>(null);
  // Follow new entries only while scrolled to the bottom.
  const stick = useRef(true);
  const buffer = useRef<LogEntryDto[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let lastId = 0;
    let cancelled = false;
    get<{ entries: LogEntryDto[] }>('/api/logs?limit=1000&level=debug')
      .then((r) => {
        if (cancelled) return;
        setEntries(r.entries);
        lastId = r.entries.at(-1)?.id ?? 0;
        es = new EventSource('/api/logs/stream');
        es.onopen = () => setConnected(true);
        let checking = false;
        es.onerror = () => {
          setConnected(false);
          // The stream also fails when the session ended – then go to the login page instead of staying "Disconnected".
          if (checking) return;
          checking = true;
          get<SessionInfo>('/api/session')
            .then((s) => {
              if (!s.authenticated && !cancelled) {
                es?.close();
                void refresh();
              }
            })
            .catch(() => undefined)
            .finally(() => {
              checking = false;
            });
        };
        es.onmessage = (ev) => {
          try {
            const e = JSON.parse(ev.data) as LogEntryDto;
            if (e.id <= lastId) return;
            lastId = e.id;
            buffer.current.push(e);
            if (buffer.current.length > MAX_ENTRIES) buffer.current.splice(0, buffer.current.length - MAX_ENTRIES);
          } catch {
            /* ignore */
          }
        };
      })
      .catch(() => undefined);
    // Batch updates to keep rendering cheap with chatty logs.
    const flush = setInterval(() => {
      if (pausedRef.current || !buffer.current.length) return;
      const add = buffer.current.splice(0);
      setEntries((list) => [...list, ...add].slice(-MAX_ENTRIES));
    }, 400);
    return () => {
      cancelled = true;
      clearInterval(flush);
      es?.close();
    };
  }, [refresh]);

  const shown = useMemo(() => {
    const min = LEVELS.indexOf(level);
    const needle = search.toLowerCase();
    return entries.filter((e) => LEVELS.indexOf(e.level) >= min || e.level === 'fatal').filter((e) => !needle || formatEntry(e).toLowerCase().includes(needle));
  }, [entries, level, search]);

  useEffect(() => {
    if (!paused && stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, paused]);

  const download = () => {
    const blob = new Blob([entries.map(formatEntry).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `paperless-ai-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card
      title="Live log"
      icon={<Activity className="size-4" />}
      description={
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('status-dot', connected ? 'live bg-success' : 'bg-border-strong')} /> {connected ? 'Streaming' : 'Disconnected'} · {shown.length} entries
        </span>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            onClick={() => {
              // Resuming follows the live log again.
              if (paused) stick.current = true;
              setPaused(!paused);
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setEntries([])}>
            Clear
          </Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={download}>
            Download
          </Button>
        </>
      }
      className="overflow-hidden"
      bodyClassName="p-0"
    >
      <div className="flex flex-wrap gap-2 px-5 pt-4 pb-4">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select className="w-36" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Minimum level">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l} +
            </option>
          ))}
        </Select>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        // A terminal: always dark.
        data-theme="dark"
        className="h-[60vh] overflow-y-auto border-t border-border bg-canvas px-4 py-3 font-mono text-[11.5px] leading-relaxed text-fg"
      >
        {shown.map((e) => (
          <div key={e.id} className="-mx-2 flex gap-2.5 rounded-md px-2 py-[3px] hover:bg-surface-2">
            <span className="shrink-0 text-faint">{new Date(e.time).toLocaleTimeString()}</span>
            <span className={cn('w-11 shrink-0 font-semibold uppercase', LEVEL_TONE[e.level])}>{e.level}</span>
            {e.module && <span className="shrink-0 text-muted">[{e.module}]</span>}
            <span className="min-w-0 break-words whitespace-pre-wrap text-fg">
              {e.msg}
              {(e.data?.err as { message?: string } | undefined)?.message && <span className="text-danger"> — {(e.data!.err as { message: string }).message}</span>}
            </span>
          </div>
        ))}
        {!shown.length && <div className="py-10 text-center text-muted">No log entries</div>}
      </div>
    </Card>
  );
}

const RESOURCES = ['documents', 'tags', 'correspondents', 'document_types', 'custom_fields', 'ui_settings', 'statistics'];

function Diagnostics() {
  const [resource, setResource] = useState('documents');
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paperless, setPaperless] = useState<ConnectionTestResult | null>(null);
  const [ai, setAi] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const fetchRaw = async () => {
    setBusy(true);
    setError(null);
    try {
      setJson(JSON.stringify(await get(`/api/debug/paperless/${resource}`), null, 2));
    } catch (err) {
      setError(errorMessage(err));
      setJson(null);
    } finally {
      setBusy(false);
    }
  };

  const runTests = async () => {
    setTesting(true);
    setPaperless(null);
    setAi(null);
    try {
      const s = await get<{ config: { paperless: { url: string; token: string }; ai: Record<string, unknown> } }>('/api/settings');
      const [p, a] = await Promise.all([
        post<ConnectionTestResult>('/api/settings/test-paperless', { url: s.config.paperless.url, token: s.config.paperless.token }).catch((e) => ({ ok: false, message: errorMessage(e) })),
        post<ConnectionTestResult>('/api/settings/test-ai', { ai: s.config.ai }).catch((e) => ({ ok: false, message: errorMessage(e) })),
      ]);
      setPaperless(p);
      setAi(a);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Connection check" icon={<Stethoscope className="size-4" />} actions={<Button size="sm" icon={<Plug className="size-3.5" />} loading={testing} onClick={runTests}>Run checks</Button>}>
        {!paperless && !ai && !testing && <p className="text-sm text-muted">Checks the connection to Paperless-ngx (incl. permissions and API version) and the AI provider.</p>}
        {paperless && (
          <div>
            <Badge>Paperless-ngx</Badge>
            <TestResult result={paperless} />
          </div>
        )}
        {ai && (
          <div className="mt-4">
            <Badge>AI provider</Badge>
            <TestResult result={ai} />
          </div>
        )}
      </Card>
      <Card
        title="Paperless API explorer"
        icon={<Bug className="size-4" />}
        description="Raw responses of the Paperless-ngx API as seen by Paperless-AI (first page)."
        actions={
          <div className="flex gap-2">
            <Select className="h-8 w-44 py-0 text-xs" value={resource} onChange={(e) => setResource(e.target.value)} aria-label="Resource">
              {RESOURCES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Button size="sm" variant="primary" loading={busy} onClick={fetchRaw}>
              Fetch
            </Button>
          </div>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {json ? <pre data-theme="dark" className="max-h-[60vh] overflow-auto rounded-xl bg-canvas p-4 font-mono text-xs text-fg">{json}</pre> : !error && <p className="text-sm text-muted">Select an endpoint and click “Fetch”.</p>}
      </Card>
    </div>
  );
}

export default function LogsPage() {
  const [tab, setTab] = useState<'logs' | 'diagnostics'>('logs');
  return (
    <Page wide>
      <PageHeader title="Logs & diagnostics" description="Live application log, connection checks and the raw Paperless API." />
      <Tabs
        id="logs"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'logs', label: 'Live log', icon: <Activity className="size-4" /> },
          { id: 'diagnostics', label: 'Diagnostics', icon: <Stethoscope className="size-4" /> },
        ]}
      />
      <div className="mt-6" {...tabPanelProps('logs', tab)}>
        {tab === 'logs' ? <LiveLogs /> : <Diagnostics />}
      </div>
    </Page>
  );
}
