/**
 * The optional Office converter of the built-in archive (Settings → Archive → Office documents):
 * Word, Excel, PowerPoint, OpenDocument and RTF files – and HTML pages and e-mails – become PDFs with
 * LibreOffice, compiled to WebAssembly (@matbee/libreoffice-converter, MPL-2.0). No external service
 * and nothing in the image: the package (~80 MB download, ~250 MB on disk) is fetched on first use
 * into <data>/office and checked against a fixed SHA-512.
 *
 * LibreOffice runs in a process of its own (host.mjs): one conversion at a time; a conversion that
 * hangs or fails is tried once more in a fresh process; when idle, the process ends and the ~1.3 GB
 * it holds are given back.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { OfficeState, OfficeStatus } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import { ArchiveError } from '../backend/types.js';
import { describeError } from '../util/http.js';
import { extractTarGz } from '../util/tar.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'office' });

/** The converter package: fixed version, checked by its SHA-512 (the npm integrity). */
export const CONVERTER_PACKAGE = {
  name: '@matbee/libreoffice-converter',
  version: '2.7.2',
  integrity: 'sha512-62S8uLiFvwbXiCu3IfkO1cDjTyZWUy5nlMsTrmj3l+G5zf5fQcgpvzfRDR9wId+bduarrv11ZDb8Olz5zj4zJA==',
  size: 79_515_284,
} as const;

const DEFAULT_URL = `https://registry.npmjs.org/${CONVERTER_PACKAGE.name}/-/libreoffice-converter-${CONVERTER_PACKAGE.version}.tgz`;
const MARKER = '.paperless-ai.json';
const HOST = fileURLToPath(new URL('./host.mjs', import.meta.url));
/** A failed download is tried again by itself after this long. */
const RETRY_AFTER_MS = 10 * 60_000;
/** Loading LibreOffice takes a few seconds; on some machines over a minute (the log then shows where the time goes). */
const START_TIMEOUT_MS = 300_000;
/** A start slower than this is logged with its steps and the machine. */
const SLOW_START_MS = 15_000;

/** Runs the conversions – the LibreOffice process, or a fake in tests. */
export interface OfficeEngine {
  readonly loaded: boolean;
  readonly rss: number | null;
  /** The process LibreOffice runs in (its memory is read from /proc). */
  readonly pid?: number | null;
  start(timeoutMs: number): Promise<void>;
  convert(data: Uint8Array, ext: string, timeoutMs: number): Promise<Uint8Array>;
  stop(): void;
}

export class OfficeTimeout extends Error {}
class Stopped extends Error {}
/** LibreOffice reported an error for the file (an engine throws it; others count as a hang or crash). */
export class OfficeRefused extends Error {}

/** LibreOffice in its own process (host.mjs). */
class ProcessEngine implements OfficeEngine {
  private child: ChildProcess | null = null;
  private readonly waiting = new Map<
    number,
    { resolve: (v: Uint8Array) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private output: string[] = [];
  rss: number | null = null;

  constructor(
    private readonly dir: string,
    private readonly fontsDir: string,
  ) {}

  get loaded(): boolean {
    return this.child !== null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private lastOutput(): string {
    const text = this.output.join('').trim().split('\n').slice(-3).join(' · ');
    return text ? ` – ${text.slice(0, 300)}` : '';
  }

  start(timeoutMs: number): Promise<void> {
    this.output = [];
    const child = fork(HOST, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // Not the options of this process (a debugger, loaders of the development server).
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    this.child = child;
    const keep = (chunk: Buffer) => {
      this.output.push(chunk.toString('utf8'));
      if (this.output.length > 50) this.output.splice(0, this.output.length - 50);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OfficeTimeout(`LibreOffice did not start within ${Math.round(timeoutMs / 1000)} s`));
        this.stop();
      }, timeoutMs);
      child.on(
        'message',
        (msg: {
          type: string;
          id?: number | null;
          data?: Uint8Array;
          message?: string;
          rss?: number;
          ms?: number;
          cpuMs?: number;
          phases?: [number, string][];
        }) => {
          if (msg.rss) this.rss = msg.rss;
          if (msg.type === 'started') child.send({ type: 'init', dir: this.dir, fontsDir: this.fontsDir });
          else if (msg.type === 'ready') {
            clearTimeout(timer);
            const s = (ms?: number) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
            log.info(`LibreOffice loaded in ${s(msg.ms)} (${Math.round((msg.rss ?? 0) / 1048576)} MB)`);
            // Where the time of a slow start goes (waiting or computing) – and on which machine.
            if ((msg.ms ?? 0) > SLOW_START_MS) {
              const steps = (msg.phases ?? []).map(([t, step]) => `${s(t)} ${step}`).join(' → ');
              log.warn(
                `LibreOffice started slowly: ${s(msg.ms)}, of which ${s(msg.cpuMs)} CPU time. Steps: ${steps}. Machine: ${machine()}`,
              );
            }
            resolve();
          } else if (msg.type === 'failed' && msg.id == null) {
            clearTimeout(timer);
            reject(new OfficeRefused(`LibreOffice could not be loaded: ${msg.message ?? 'unknown error'}`));
            this.stop();
          } else if (msg.id != null) {
            const w = this.waiting.get(msg.id);
            if (!w) return;
            this.waiting.delete(msg.id);
            clearTimeout(w.timer);
            if (msg.type === 'done' && msg.data) w.resolve(msg.data);
            else w.reject(new OfficeRefused(msg.message || 'the conversion failed'));
          }
        },
      );
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        const why = new Stopped(`LibreOffice stopped (${signal ?? `exit code ${code}`})${this.lastOutput()}`);
        reject(why);
        for (const [id, w] of this.waiting) {
          clearTimeout(w.timer);
          w.reject(why);
          this.waiting.delete(id);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  convert(data: Uint8Array, ext: string, timeoutMs: number): Promise<Uint8Array> {
    const child = this.child;
    if (!child) return Promise.reject(new Stopped('LibreOffice is not running'));
    const id = ++this.seq;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new OfficeTimeout(`the conversion took longer than ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.send({ type: 'convert', id, data, ext, pdfa: true });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.rss = null;
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}

export class OfficeService {
  /** Tests: a fake engine (counts as installed). */
  engineFactory: (() => OfficeEngine) | null = null;
  private engine: OfficeEngine | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private installing: Promise<void> | null = null;
  private progress: { received: number; total: number | null } | null = null;
  private phase: 'downloading' | 'installing' | null = null;
  private installError: string | null = null;
  private failedAt = 0;
  private stats = { conversions: 0, failures: 0, lastMs: null as number | null };
  private closed = false;
  /** How long the last start of LibreOffice took and how much memory it held (shown in the settings). */
  private lastStartMs: number | null = null;
  private lastMemory: number | null = null;
  /** The service of the running archive (not a passive one): it loads LibreOffice in advance. */
  private active = false;
  /** LibreOffice is being started. */
  private starting = false;

  constructor(
    private readonly ctx: AppContext,
    opts: { watchConfig?: boolean } = {},
  ) {
    if (!opts.watchConfig) return;
    this.active = true;
    ctx.config.on('change', this.onConfig);
    if (this.enabled && !this.installed()) void this.install().catch(() => undefined);
    else this.preload();
  }

  /** "Keep LibreOffice loaded" (idle minutes 0): no waiting for it to start, its memory stays in use. */
  get keepLoaded(): boolean {
    return this.ctx.cfg.archive.builtin.office.idleMinutes === 0;
  }

  /** Load LibreOffice in the background when it is to be kept loaded (at start, when switched on, after the download). */
  private preload(): void {
    if (!this.active || this.closed || !this.ready() || !this.keepLoaded || this.engine?.loaded) return;
    const run = this.chain.then(() => (this.engine?.loaded ? undefined : this.load()));
    this.chain = run.catch(() => undefined);
    run.catch((err: unknown) =>
      log.warn(
        `LibreOffice could not be loaded in advance: ${describeError(err)} – it is tried again with the next Office document`,
      ),
    );
  }

  get dir(): string {
    return path.join(this.ctx.dataDir, 'office');
  }

  private get packageDir(): string {
    return path.join(this.dir, `libreoffice-${CONVERTER_PACKAGE.version}`);
  }

  get enabled(): boolean {
    return this.ctx.cfg.archive.builtin.office.enabled;
  }

  installed(): boolean {
    return Boolean(this.engineFactory) || fs.existsSync(path.join(this.packageDir, MARKER));
  }

  /** Office documents can be converted now. */
  ready(): boolean {
    return this.enabled && this.installed();
  }

  private readonly onConfig = (next: AppConfig) => {
    if (this.closed) return;
    if (!next.archive.builtin.office.enabled) {
      this.unload('switched off');
      return;
    }
    if (!this.installed()) void this.install().catch(() => undefined);
    else if (this.keepLoaded) this.preload();
    // From "keep loaded" back to unloading when idle.
    else if (this.engine?.loaded && !this.idleTimer) this.armIdle();
  };

  /** Memory of the LibreOffice process right now (from /proc where there is one), else as it last reported. */
  private memory(): number | null {
    const engine = this.engine;
    if (!engine?.loaded) return null;
    if (engine.pid) {
      try {
        const kb = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${engine.pid}/status`, 'utf8'))?.[1];
        if (kb) return Number(kb) * 1024;
      } catch {
        /* no /proc (macOS, Windows) */
      }
    }
    return engine.rss;
  }

  status(): OfficeStatus {
    const memory = this.memory();
    if (memory && !this.starting) this.lastMemory = memory;
    const state: OfficeState = !this.enabled
      ? 'off'
      : this.phase
        ? this.phase
        : this.installed()
          ? 'ready'
          : this.installError
            ? 'failed'
            : 'not_installed';
    return {
      enabled: this.enabled,
      state,
      version: CONVERTER_PACKAGE.version,
      received: this.progress?.received ?? null,
      total: this.progress?.total ?? null,
      error: this.installError,
      loaded: Boolean(this.engine?.loaded) && !this.starting,
      starting: this.starting,
      memoryMb: memory ? Math.round(memory / 1048576) : null,
      lastMemoryMb: this.lastMemory ? Math.round(this.lastMemory / 1048576) : null,
      lastStartMs: this.lastStartMs,
      keepLoaded: this.keepLoaded,
      ...this.stats,
      dir: this.packageDir,
    };
  }

  // ------------------------------------------------------------ installation

  /**
   * Download, check and unpack the converter (once; later calls wait for the running one). After a
   * failure it is tried again by itself only after 10 minutes – `force` (the button) tries at once.
   */
  install(opts: { force?: boolean } = {}): Promise<void> {
    if (this.installed()) return Promise.resolve();
    if (!this.installing && !opts.force && this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_MS)
      return Promise.reject(new Error(this.installError ?? 'Not installed'));
    this.installing ??= this.runInstall().finally(() => {
      this.installing = null;
      this.phase = null;
    });
    return this.installing;
  }

  private async runInstall(): Promise<void> {
    this.installError = null;
    const { version, integrity } = CONVERTER_PACKAGE;
    await fsp.mkdir(this.dir, { recursive: true });
    // Offline installation: the package file put into <data>/office by hand.
    const local = path.join(this.dir, `libreoffice-converter-${version}.tgz`);
    const download = path.join(this.dir, `download-${process.pid}.tgz`);
    const part = `${this.packageDir}.part`;
    try {
      let tarball = local;
      if (!fs.existsSync(local)) {
        const url = process.env.PAPERLESS_AI_OFFICE_URL?.trim() || DEFAULT_URL;
        this.phase = 'downloading';
        log.info(
          `Downloading the Office converter (LibreOffice ${version}, ~${Math.round(CONVERTER_PACKAGE.size / 1048576)} MB) from ${new URL(url).host} …`,
        );
        await this.fetchTo(url, download);
        tarball = download;
      }
      this.phase = 'installing';
      const actual = await sha512(tarball);
      if (actual !== integrity)
        throw new Error(
          `The downloaded file is not the expected one (SHA-512 differs) – ${tarball === local ? 'replace the file in the office folder' : 'try again later'}`,
        );
      await fsp.rm(part, { recursive: true, force: true });
      const files = await extractTarGz(tarball, part, {
        strip: 1,
        skip: (f) => /\.(map|d\.ts|d\.cts)$/.test(f) || /^dist\/browser/.test(f),
      });
      await linkDependency(part, 'zod');
      await fsp.writeFile(
        path.join(part, MARKER),
        JSON.stringify({ name: CONVERTER_PACKAGE.name, version, integrity, installedAt: new Date().toISOString() }),
      );
      await fsp.rm(this.packageDir, { recursive: true, force: true });
      await fsp.rename(part, this.packageDir);
      // Other versions are no longer used.
      for (const name of await fsp.readdir(this.dir)) {
        if (name.startsWith('libreoffice-') && !name.endsWith('.tgz') && path.join(this.dir, name) !== this.packageDir)
          await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
      }
      log.info(`Office converter installed (${files} files in ${this.packageDir})`);
      this.installing = null;
      this.phase = null;
      this.preload();
    } catch (err) {
      this.installError = describeError(err);
      this.failedAt = Date.now();
      log.warn(`The Office converter could not be installed: ${this.installError}`);
      await fsp.rm(part, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      this.progress = null;
      await fsp.rm(download, { force: true }).catch(() => undefined);
    }
  }

  private async fetchTo(url: string, target: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000), redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${new URL(url).host}`);
    const total = Number(res.headers.get('content-length')) || CONVERTER_PACKAGE.size;
    this.progress = { received: 0, total };
    const progress = this.progress;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        progress.received += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, fs.createWriteStream(target));
  }

  // ------------------------------------------------------------ conversion

  /**
   * A PDF of a file (Office document, HTML page). `ext` names the format (docx, xlsx, html …).
   * ArchiveError 415 when the converter is off, 503 while it is downloaded or when LibreOffice hangs
   * (try again later), 422 when LibreOffice cannot read the file.
   */
  toPdf(data: Uint8Array, ext: string): Promise<Uint8Array> {
    if (!this.enabled)
      return Promise.reject(
        new ArchiveError('Office documents need the Office converter – switch it on in Settings → Archive', 415, 'office_off'),
      );
    if (!this.installed()) {
      void this.install().catch(() => undefined);
      const why = this.installError ? `could not be downloaded (${this.installError})` : 'is being downloaded';
      return Promise.reject(
        new ArchiveError(`The Office converter ${why} – the file can be tried again later`, 503, 'office_not_ready'),
      );
    }
    const run = this.chain.then(() => this.convert(data, ext));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async convert(data: Uint8Array, ext: string): Promise<Uint8Array> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeoutMs = this.ctx.cfg.archive.builtin.office.timeoutSeconds * 1000;
    let last: unknown = null;
    try {
      // A hang or failure is tried once more in a fresh process (LibreOffice sometimes stalls on a first file).
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const engine = await this.load();
          const started = Date.now();
          const pdf = await engine.convert(data, ext, timeoutMs);
          this.stats.conversions++;
          this.stats.lastMs = Date.now() - started;
          return pdf;
        } catch (err) {
          last = err;
          log.warn(`Office conversion (${ext}, attempt ${attempt} of 2) failed: ${describeError(err)}`);
          this.unload('after a failed conversion');
        }
      }
    } finally {
      this.armIdle();
    }
    this.stats.failures++;
    if (last instanceof OfficeRefused)
      throw new ArchiveError(`LibreOffice could not convert this file: ${last.message}`, 422, 'office_failed');
    throw new ArchiveError(
      `The Office converter did not finish: ${describeError(last)} – the file can be tried again later`,
      503,
      'office_unavailable',
    );
  }

  private async load(): Promise<OfficeEngine> {
    if (this.engine?.loaded) return this.engine;
    // The link to the app's own dependency breaks when the app moved (another image, another folder).
    if (!this.engineFactory && !fs.existsSync(path.join(this.packageDir, 'node_modules', 'zod', 'package.json'))) {
      await fsp.rm(path.join(this.packageDir, 'node_modules', 'zod'), { recursive: true, force: true });
      await linkDependency(this.packageDir, 'zod');
    }
    const engine = this.engineFactory ? this.engineFactory() : new ProcessEngine(this.packageDir, path.join(this.dir, 'fonts'));
    this.engine = engine;
    const started = Date.now();
    this.starting = true;
    try {
      await engine.start(START_TIMEOUT_MS);
    } finally {
      this.starting = false;
    }
    this.lastStartMs = Date.now() - started;
    this.lastMemory = this.memory() ?? this.lastMemory;
    this.armIdle();
    return engine;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed || !this.engine?.loaded || this.keepLoaded) return;
    const minutes = this.ctx.cfg.archive.builtin.office.idleMinutes;
    this.idleTimer = setTimeout(() => this.unload(`after ${minutes} min without work`), minutes * 60_000);
    this.idleTimer.unref();
  }

  /** End the LibreOffice process (its memory is given back). */
  unload(reason: string): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const memory = this.memory();
    if (memory) this.lastMemory = memory;
    const engine = this.engine;
    this.engine = null;
    if (engine?.loaded) {
      log.info(`LibreOffice unloaded ${reason}${memory ? ` (${Math.round(memory / 1048576)} MB given back)` : ''}`);
      engine.stop();
    }
  }

  close(): void {
    this.closed = true;
    this.ctx.config.off('change', this.onConfig);
    this.unload('at shutdown');
  }
}

async function sha512(file: string): Promise<string> {
  const hash = createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return `sha512-${hash.digest('base64')}`;
}

/** Make a dependency of this app visible to the unpacked package (a link, or a copy where links fail). */
async function linkDependency(packageDir: string, name: string): Promise<void> {
  const source = path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  const target = path.join(packageDir, 'node_modules', name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.symlink(source, target, 'junction');
  } catch {
    await fsp.cp(source, target, { recursive: true });
  }
}

/** The machine, for the log of a slow start: CPU, cores, memory and the limits of the container. */
export function machine(): string {
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const cpus = os.cpus();
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const memLimit = read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const cpuLimit = read('/sys/fs/cgroup/cpu.max');
  return [
    `${cpus.length}× ${cpus[0]?.model?.trim() || 'unknown CPU'} (${os.arch()}, ${os.availableParallelism()} usable)`,
    `memory ${gb(os.totalmem())}, ${gb(os.freemem())} free`,
    memLimit && /^\d+$/.test(memLimit) && Number(memLimit) < 2 ** 60 ? `container memory limit ${gb(Number(memLimit))}` : null,
    cpuLimit && !cpuLimit.startsWith('max') ? `container CPU limit ${cpuLimit}` : null,
    `load ${os
      .loadavg()
      .map((l) => l.toFixed(1))
      .join('/')}`,
    `Node ${process.versions.node}`,
  ]
    .filter(Boolean)
    .join(', ');
}
