/**
 * Application logger (pino) writing human readable lines to stdout and keeping
 * the most recent entries in memory for the log viewer in the web UI.
 */
import { EventEmitter } from 'node:events';
import { pino, stdSerializers, type Logger } from 'pino';

export interface LogEntry {
  id: number;
  time: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  module?: string;
  msg: string;
  /** Additional structured data (error details etc.), already redacted. */
  data?: Record<string, unknown>;
}

const LEVELS: Record<number, LogEntry['level']> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const COLORS: Record<LogEntry['level'], string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m',
};
const MAX_ENTRIES = 2000;

class LogBuffer extends EventEmitter<{ entry: [LogEntry] }> {
  private entries: LogEntry[] = [];
  private nextId = 1;

  push(e: Omit<LogEntry, 'id'>): LogEntry {
    const entry = { ...e, id: this.nextId++ };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entry', entry);
    return entry;
  }

  list(opts: { after?: number; level?: LogEntry['level']; limit?: number; search?: string } = {}): LogEntry[] {
    const minLevel = opts.level ? Object.values(LEVELS).indexOf(opts.level) : 0;
    const needle = opts.search?.toLowerCase();
    let out = this.entries.filter(
      (e) =>
        (opts.after === undefined || e.id > opts.after) &&
        Object.values(LEVELS).indexOf(e.level) >= minLevel &&
        (!needle || e.msg.toLowerCase().includes(needle) || (e.module ?? '').includes(needle)),
    );
    if (opts.limit) out = out.slice(-opts.limit);
    return out;
  }

  clear(): void {
    this.entries = [];
  }
}

export const logBuffer = new LogBuffer();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const jsonOutput = process.env.LOG_FORMAT === 'json';

const IGNORED_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'module', 'v', 'reqId']);

function formatLine(entry: Omit<LogEntry, 'id'>): string {
  const d = new Date(entry.time);
  const ts = `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`;
  const lvl = entry.level.toUpperCase().padEnd(5);
  const mod = entry.module ? `[${entry.module}] ` : '';
  let extra = '';
  if (entry.data) {
    const err = entry.data.err as { message?: string; stack?: string } | undefined;
    const rest = Object.fromEntries(Object.entries(entry.data).filter(([k]) => k !== 'err'));
    if (Object.keys(rest).length) extra += ` ${JSON.stringify(rest)}`;
    if (err?.message) extra += ` — ${err.message}`;
    if (err?.stack && (entry.level === 'error' || entry.level === 'fatal' || process.env.LOG_LEVEL === 'debug')) {
      extra += `\n${err.stack.split('\n').slice(1, 6).join('\n')}`;
    }
  }
  const line = `${ts} ${lvl} ${mod}${entry.msg}${extra}`;
  return useColor ? `${COLORS[entry.level]}${line}\x1b[0m` : line;
}

const destination = {
  write(chunk: string) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(chunk) as Record<string, unknown>;
    } catch {
      process.stdout.write(chunk);
      return;
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (!IGNORED_KEYS.has(k)) data[k] = v;
    const entry = logBuffer.push({
      time: typeof obj.time === 'number' ? obj.time : Date.now(),
      level: LEVELS[obj.level as number] ?? 'info',
      module: typeof obj.module === 'string' ? obj.module : undefined,
      msg: String(obj.msg ?? ''),
      data: Object.keys(data).length ? data : undefined,
    });
    if (jsonOutput) process.stdout.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`);
    else process.stdout.write(`${formatLine(entry)}\n`);
  },
};

export const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: undefined,
    redact: {
      paths: [
        '*.token',
        '*.apiKey',
        '*.api_key',
        '*.password',
        '*.jwtSecret',
        'headers.authorization',
        'headers["x-api-key"]',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
      ],
      censor: '[redacted]',
    },
    serializers: { err: stdSerializers.err },
  },
  destination,
);

export type { Logger };
