/**
 * Watch folders of the built-in archive (docs/standalone/ingest.md §5).
 *
 * Polling instead of inotify: changes written through SMB/NFS mounts – how scanners deliver – are not
 * reported by inotify. A file is taken only when its size and mtime did not change between two polls.
 * After the intake it is deleted or moved to .done/<date>/; files that were refused go to .failed/
 * with a .error.txt next to them.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { systemScope, type AccessScope } from '../access/scope.js';
import type { IngestHints } from '../backend/types.js';
import type { AppConfig } from '../config/schema.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import type { LocalBackend } from './backend.js';

const log = logger.child({ module: 'intake' });

const IGNORED = /^(\.|~\$)|\.(tmp|part|crdownload|download|swp)$|^(Thumbs\.db|desktop\.ini)$/i;
const SPECIAL_DIRS = new Set(['.done', '.failed', '@eaDir', '#recycle', '.Trash-1000', 'lost+found']);
/** At most this many files per poll (the rest follows with the next one). */
const PER_POLL = 50;
/** Never watched: what is in there is no inbox, and it would be imported and removed. */
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr'];

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Why a directory cannot be a watch folder, or null. A watch folder imports every file and then
 * removes it – pointed at the data directory, the file storage or the program, it would move the
 * database away and delete the stored originals.
 */
export function watchFolderProblem(dir: string, protectedDirs: string[], programDirs: string[] = [], followLinks = true): string | null {
  if (!dir.trim()) return 'The folder is empty';
  if (!path.isAbsolute(dir)) return 'Give the folder as an absolute path, e.g. /consume';
  // Entered paths are checked as written (the watcher checks again with links resolved before every poll).
  const target = followLinks ? realPath(dir) : path.resolve(dir);
  if (target === path.parse(target).root) return 'The root directory cannot be a watch folder';
  for (const sys of SYSTEM_DIRS) {
    if (target === sys || target.startsWith(sys + path.sep)) return `${sys} is a system directory – use a folder of its own, e.g. /consume`;
  }
  for (const p of [...new Set(protectedDirs.filter(Boolean).map(realPath))]) {
    if (target === p || target.startsWith(p + path.sep)) return `The folder is inside ${p}, which Paperless-AI uses itself – use a folder of its own, e.g. /consume`;
    if (p.startsWith(target + path.sep)) return `The folder contains ${p}, which Paperless-AI uses itself – its files would be imported and removed`;
  }
  // The program directory: a folder of its own below it is fine (./consume), the directory itself or above is not.
  for (const p of programDirs.filter(Boolean).map(realPath)) {
    if (target === p || p.startsWith(target + path.sep)) return `The folder contains the program (${p}) – use a folder of its own, e.g. /consume`;
  }
  return null;
}

/** Why an entered directory cannot be a watch folder with this configuration (settings, setup, libraries), or null. */
export function watchFolderProblemFor(dir: string, dataDir: string, cfg: AppConfig): string | null {
  const b = cfg.archive.builtin;
  return watchFolderProblem(dir, [dataDir, b.storageDir || path.join(dataDir, 'library'), path.join(dataDir, 'tmp'), path.join(dataDir, 'exports'), b.exportDir], [process.cwd()], false);
}

export interface FolderConfig {
  id: number | null;
  path: string;
  libraryId: number | null;
  hints: IngestHints;
  subfolders: 'ignore' | 'tags' | 'library';
  after: 'delete' | 'move';
  actAs: number | null;
}

interface Seen {
  size: number;
  mtimeMs: number;
  stableSince: number;
}

export class FolderWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, Seen>();
  private polling: Promise<number> | null = null;
  private stopped = false;
  lastError: string | null = null;
  /** What keeps each folder (by its configured path) from working – shown with the folder. */
  private readonly problems = new Map<string, string>();

  /** The problem of a watch folder (missing, refused, unreadable files …), or null. */
  problemOf(folderPath: string): string | null {
    return this.problems.get(folderPath) ?? null;
  }

  constructor(private readonly backend: LocalBackend) {}

  private get ctx() {
    return this.backend.ctx;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.poll().finally(schedule), this.ctx.cfg.archive.builtin.consumePollSeconds * 1000);
      this.timer.unref();
    };
    schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Why a directory cannot be a watch folder of this instance, or null (see watchFolderProblem). */
  problem(dir: string): string | null {
    return watchFolderProblem(dir, [this.ctx.dataDir, this.backend.blobs.root, path.join(this.ctx.dataDir, 'tmp'), path.join(this.ctx.dataDir, 'exports'), this.ctx.cfg.archive.builtin.exportDir], [process.cwd()]);
  }

  /** Configured folders: the environment/settings folder plus the ones of the libraries (not deleted ones). */
  folders(): FolderConfig[] {
    const out: FolderConfig[] = [];
    const b = this.ctx.cfg.archive.builtin;
    const main = b.consumeDir.trim();
    if (main) {
      const lib = b.consumeLibrary ? this.ctx.repos.libraries.get(b.consumeLibrary) : undefined;
      out.push({ id: null, path: main, libraryId: lib && !lib.deleted_at ? lib.id : null, hints: {}, subfolders: b.consumeSubfolders, after: b.consumeAfter, actAs: null });
    }
    const rows = this.ctx.db
      .prepare('SELECT f.* FROM intake_folders f JOIN libraries l ON l.id = f.library_id AND l.deleted_at IS NULL WHERE f.enabled = 1')
      .all() as {
      id: number;
      library_id: number;
      path: string;
      hints: string;
      subfolders: FolderConfig['subfolders'];
      after: FolderConfig['after'];
      act_as: number | null;
    }[];
    for (const r of rows) {
      // A library's folder stores into that library only ("library" subfolders are for the main folder).
      out.push({ id: r.id, path: r.path, libraryId: r.library_id, hints: JSON.parse(r.hints || '{}') as IngestHints, subfolders: r.subfolders === 'library' ? 'tags' : r.subfolders, after: r.after, actAs: r.act_as });
    }
    return out;
  }

  /** Look at all folders once. Returns the number of files taken in. */
  poll(): Promise<number> {
    this.polling ??= this.doPoll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async doPoll(): Promise<number> {
    let taken = 0;
    const folders = this.folders();
    const problems = new Map<string, string>();
    // A folder inside another watch folder belongs to the inner one only (not taken twice).
    const roots = folders.map((f) => realPath(f.path));
    for (const folder of folders) {
      const problem = this.problem(folder.path);
      if (problem) {
        problems.set(folder.path, problem);
        continue;
      }
      if (!fs.existsSync(folder.path)) {
        problems.set(folder.path, `The folder ${folder.path} does not exist in the container – is the host folder mounted (docker-compose volumes)?`);
        continue;
      }
      try {
        const own = realPath(folder.path);
        const res = await this.pollFolder(folder, new Set(roots.filter((r) => r !== own && r.startsWith(own + path.sep))));
        taken += res.taken;
        if (res.problem) problems.set(folder.path, res.problem);
      } catch (err) {
        problems.set(folder.path, describeError(err));
      }
    }
    const text = [...problems].map(([p, m]) => `${p}: ${m}`).join('\n');
    if (text && text !== this.lastError) log.warn(`Watch folders: ${text.replace(/\n/g, '; ')}`);
    this.lastError = text || null;
    this.problems.clear();
    for (const [p, m] of problems) this.problems.set(p, m);
    return taken;
  }

  private async *files(root: string, skip: Set<string>, dir = root, depth = 0): AsyncGenerator<string> {
    if (depth > 5) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        if (!SPECIAL_DIRS.has(entry.name) && !entry.name.startsWith('.') && !skip.has(realPath(sub))) yield* this.files(root, skip, sub, depth + 1);
      } else if (entry.isFile() && !IGNORED.test(entry.name)) yield path.join(dir, entry.name);
    }
  }

  private async pollFolder(folder: FolderConfig, skip: Set<string>): Promise<{ taken: number; problem: string | null }> {
    const now = Date.now();
    const present = new Set<string>();
    const ready: string[] = [];
    const unreadable: string[] = [];
    for await (const file of this.files(folder.path, skip)) {
      present.add(file);
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      const prev = this.seen.get(file);
      if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
        // New or still being written: wait for the next poll.
        this.seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, stableSince: now });
        continue;
      }
      if (st.size === 0) continue;
      if (await this.readable(file)) ready.push(file);
      else unreadable.push(path.relative(folder.path, file));
      if (ready.length >= PER_POLL) break;
    }
    // Forget files that are gone – but not those of a nested watch folder (they were not listed here).
    const prefix = folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep;
    const nested = [...skip].map((d) => d + path.sep);
    for (const k of this.seen.keys()) {
      if (k.startsWith(prefix) && !present.has(k) && !nested.some((n) => realPath(path.dirname(k)).concat(path.sep).startsWith(n))) this.seen.delete(k);
    }
    let taken = 0;
    const kept: string[] = [];
    for (const file of ready) {
      if (this.stopped) break;
      const r = await this.take(folder, file);
      if (r.stored) taken++;
      if (r.problem) kept.push(r.problem);
    }
    // Paperless-AI runs without the right to override file permissions (cap_drop: ALL): a file of
    // another user that is not readable for others stays where it is – say so instead of waiting.
    const problem = unreadable.length
      ? `${unreadable.length} file(s) cannot be read (${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ' …' : ''}) – make them readable and the folder writable, e.g. chmod -R a+rwX on the host folder`
      : (kept[0] ?? null);
    return { taken, problem };
  }

  /**
   * The file can be read. (Being written is told by size and mtime, which must not change between two
   * polls – opening for writing would refuse files of another user, which only need to be readable.)
   */
  private async readable(file: string): Promise<boolean> {
    try {
      const fh = await fsp.open(file, 'r');
      await fh.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The rights the intake of a folder has: a library's folder adds to its library only – whoever set
   * it up (administrators need not be members of the library); the main folder adds to any library.
   */
  private scopeFor(folder: FolderConfig): AccessScope {
    const task = folder.id ? `folder:${folder.id}` : 'folder';
    if (folder.id && folder.libraryId) return { principal: { kind: 'system', task }, libraries: new Map([[folder.libraryId, 'editor' as const]]), scopes: null };
    return systemScope(task);
  }

  private async take(folder: FolderConfig, file: string): Promise<{ stored: boolean; problem: string | null }> {
    const st = await fsp.stat(file);
    const rel = path.relative(folder.path, file);
    const parts = rel.split(path.sep).slice(0, -1);
    const hints: IngestHints = {
      ...folder.hints,
      channelRef: `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`,
      // For workflow conditions ("folder contains …").
      context: { ...folder.hints.context, folder: path.dirname(path.resolve(file)) },
    };
    if (folder.libraryId) hints.libraryId = folder.libraryId;
    if (parts.length && folder.subfolders === 'tags') hints.tags = [...(hints.tags ?? []), ...parts];
    if (parts.length && folder.subfolders === 'library') {
      // Family/Taxes/scan.pdf → library "Family", tag "Taxes"; an unknown first folder is a tag as well.
      const lib = this.ctx.repos.libraries.list().find((l) => l.name.toLowerCase() === parts[0].toLowerCase());
      if (lib) hints.libraryId = lib.id;
      const tags = lib ? parts.slice(1) : parts;
      if (tags.length) hints.tags = [...(hints.tags ?? []), ...tags];
    }
    let res: Awaited<ReturnType<LocalBackend['ingest']>>;
    try {
      res = await this.backend.ingest(this.scopeFor(folder), { path: file, filename: path.basename(file) }, 'folder', hints);
    } catch (err) {
      res = { status: 'rejected', reason: describeError(err) };
    }
    log.info(`Watch folder: "${rel}" → ${res.status}${res.documentId ? ` (document ${res.documentId})` : ''}${res.reason ? ` (${res.reason})` : ''}`);
    try {
      if (res.status === 'rejected' || res.status === 'failed') await this.moveTo(folder, file, '.failed', res.reason ?? 'refused');
      else if (folder.after === 'move') await this.moveTo(folder, file, path.join('.done', new Date().toISOString().slice(0, 10)));
      else await fsp.rm(file, { force: true });
      this.seen.delete(file);
    } catch (err) {
      // Stored, but the file stays (the folder is not writable): it is not stored twice (same
      // reference), but the folder shows why it does not empty.
      return { stored: res.status === 'stored', problem: `"${rel}" ${res.status === 'stored' || res.status === 'duplicate' ? 'was stored but' : 'was refused and'} cannot be removed from the folder (${describeError(err)}) – make the folder writable, e.g. chmod -R a+rwX on the host folder` };
    }
    return { stored: res.status === 'stored', problem: null };
  }

  private async moveTo(folder: FolderConfig, file: string, sub: string, error?: string): Promise<void> {
    const dir = path.join(folder.path, sub);
    await fsp.mkdir(dir, { recursive: true });
    let target = path.join(dir, path.basename(file));
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.parse(file).name}-${i}${path.extname(file)}`);
    await fsp.rename(file, target).catch(async () => {
      await fsp.copyFile(file, target);
      await fsp.rm(file, { force: true });
    });
    if (error) await fsp.writeFile(`${target}.error.txt`, `${new Date().toISOString()}\n${error}\n`);
  }
}
