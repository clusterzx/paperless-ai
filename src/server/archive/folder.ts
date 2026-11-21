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
import { userScope } from '../access/context.js';
import type { IngestHints } from '../backend/types.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import type { LocalBackend } from './backend.js';

const log = logger.child({ module: 'intake' });

const IGNORED = /^(\.|~\$)|\.(tmp|part|crdownload|download|swp)$|^(Thumbs\.db|desktop\.ini)$/i;
const SPECIAL_DIRS = new Set(['.done', '.failed', '@eaDir', '#recycle', '.Trash-1000', 'lost+found']);
/** At most this many files per poll (the rest follows with the next one). */
const PER_POLL = 50;

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

  /** Configured folders: the environment/settings folder plus the ones of the libraries. */
  folders(): FolderConfig[] {
    const out: FolderConfig[] = [];
    const main = this.ctx.cfg.archive.builtin.consumeDir.trim();
    if (main) out.push({ id: null, path: main, libraryId: null, hints: {}, subfolders: 'tags', after: this.ctx.cfg.archive.builtin.consumeAfter, actAs: null });
    const rows = this.ctx.db.prepare('SELECT * FROM intake_folders WHERE enabled = 1').all() as {
      id: number;
      library_id: number;
      path: string;
      hints: string;
      subfolders: FolderConfig['subfolders'];
      after: FolderConfig['after'];
      act_as: number | null;
    }[];
    for (const r of rows) {
      out.push({ id: r.id, path: r.path, libraryId: r.library_id, hints: JSON.parse(r.hints || '{}') as IngestHints, subfolders: r.subfolders, after: r.after, actAs: r.act_as });
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
    for (const folder of this.folders()) {
      if (!fs.existsSync(folder.path)) {
        this.lastError = `The watch folder ${folder.path} does not exist`;
        continue;
      }
      try {
        taken += await this.pollFolder(folder);
        this.lastError = null;
      } catch (err) {
        this.lastError = `${folder.path}: ${describeError(err)}`;
        log.warn(`Watch folder ${folder.path}: ${describeError(err)}`);
      }
    }
    return taken;
  }

  private async *files(root: string, dir = root, depth = 0): AsyncGenerator<string> {
    if (depth > 5) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SPECIAL_DIRS.has(entry.name) && !entry.name.startsWith('.')) yield* this.files(root, path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && !IGNORED.test(entry.name)) yield path.join(dir, entry.name);
    }
  }

  private async pollFolder(folder: FolderConfig): Promise<number> {
    const now = Date.now();
    const present = new Set<string>();
    const ready: string[] = [];
    for await (const file of this.files(folder.path)) {
      present.add(file);
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      const prev = this.seen.get(file);
      if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
        // New or still being written: wait for the next poll.
        this.seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, stableSince: now });
        continue;
      }
      if (st.size > 0 && (await this.exclusive(file))) ready.push(file);
      if (ready.length >= PER_POLL) break;
    }
    for (const k of this.seen.keys()) if (k.startsWith(folder.path) && !present.has(k)) this.seen.delete(k);
    let taken = 0;
    for (const file of ready) {
      if (this.stopped) break;
      if (await this.take(folder, file)) taken++;
    }
    return taken;
  }

  /** The file can be opened for writing (no scanner writes to it any more). */
  private async exclusive(file: string): Promise<boolean> {
    try {
      const fh = await fsp.open(file, 'r+');
      await fh.close();
      return true;
    } catch {
      return false;
    }
  }

  private scopeFor(folder: FolderConfig): AccessScope {
    if (folder.actAs) {
      const s = userScope(this.ctx, folder.actAs);
      if (s) return s;
    }
    return systemScope(folder.id ? `folder:${folder.id}` : 'folder');
  }

  private async take(folder: FolderConfig, file: string): Promise<boolean> {
    const st = await fsp.stat(file);
    const rel = path.relative(folder.path, file);
    const parts = rel.split(path.sep).slice(0, -1);
    const hints: IngestHints = { ...folder.hints, channelRef: `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}` };
    if (folder.libraryId) hints.libraryId = folder.libraryId;
    if (parts.length && folder.subfolders === 'tags') hints.tags = [...(hints.tags ?? []), ...parts];
    if (parts.length && folder.subfolders === 'library') {
      const lib = this.ctx.repos.libraries.list().find((l) => l.name.toLowerCase() === parts[0].toLowerCase());
      if (lib) hints.libraryId = lib.id;
    }
    try {
      const res = await this.backend.ingest(this.scopeFor(folder), { path: file, filename: path.basename(file) }, 'folder', hints);
      if (res.status === 'rejected') await this.moveTo(folder, file, '.failed', res.reason ?? 'refused');
      else if (folder.after === 'move') await this.moveTo(folder, file, path.join('.done', new Date().toISOString().slice(0, 10)));
      else await fsp.rm(file, { force: true });
      this.seen.delete(file);
      log.info(`Watch folder: "${rel}" → ${res.status}${res.documentId ? ` (document ${res.documentId})` : ''}`);
      return res.status === 'stored';
    } catch (err) {
      await this.moveTo(folder, file, '.failed', describeError(err)).catch(() => undefined);
      this.seen.delete(file);
      log.warn(`Watch folder: "${rel}" failed: ${describeError(err)}`);
      return false;
    }
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
