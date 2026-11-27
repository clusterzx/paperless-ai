/**
 * Blob store of the built-in archive: immutable files named by their SHA-256.
 *
 *   <root>/blobs/ab/cd/<sha256>   files (read-only)
 *   <root>/thumbs/<doc>-v<n>.webp thumbnails (derived, can be regenerated)
 *   <root>/tmp/                   files being written (same file system → atomic rename)
 *
 * Write protocol (docs/standalone/data-model.md §4): write to tmp while hashing → fsync → rename
 * into place (or drop the copy when the blob exists) → the caller records it in the database in one
 * transaction. Files without database rows are collected by gc().
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { ArchiveError } from '../backend/types.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'archive' });

export interface StoredBlob {
  sha256: string;
  size: number;
  /** The file existed already (identical content). */
  existed: boolean;
}

const MARKER = '.paperless-ai-store';

export class BlobStore {
  readonly blobsDir: string;
  readonly thumbsDir: string;
  readonly tmpDir: string;

  constructor(readonly root: string) {
    this.blobsDir = path.join(root, 'blobs');
    this.thumbsDir = path.join(root, 'thumbs');
    this.tmpDir = path.join(root, 'tmp');
    for (const d of [this.blobsDir, this.thumbsDir, this.tmpDir]) fs.mkdirSync(d, { recursive: true });
    // A marker with a store id protects against a wrong or empty mount being used as the store.
    const marker = path.join(root, MARKER);
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ id: randomUUID(), created: new Date().toISOString() }));
  }

  /** Store id from the marker file. */
  storeId(): string {
    try {
      return (JSON.parse(fs.readFileSync(path.join(this.root, MARKER), 'utf8')) as { id: string }).id;
    } catch {
      return 'unknown';
    }
  }

  pathOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ArchiveError('Invalid blob id', 400);
    return path.join(this.blobsDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  has(sha256: string): boolean {
    return fs.existsSync(this.pathOf(sha256));
  }

  /** Stream into the store; enforces `maxBytes` while writing. */
  async putStream(source: Readable, maxBytes = Number.POSITIVE_INFINITY): Promise<StoredBlob> {
    const tmp = path.join(this.tmpDir, `${Date.now()}-${randomUUID()}`);
    const hash = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new ArchiveError(`The file is larger than the limit of ${Math.round(maxBytes / 1048576)} MB`, 413, 'too_large'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o640 });
      await pipeline(source, counter, out);
      await this.fsyncFile(tmp);
      return await this.commit(tmp, hash.digest('hex'), size);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async putBytes(data: Uint8Array): Promise<StoredBlob> {
    const { Readable } = await import('node:stream');
    return this.putStream(Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
  }

  /** Store a file from disk (hashing it on the way). The source file is not changed. */
  async putFile(file: string, maxBytes?: number): Promise<StoredBlob> {
    return this.putStream(fs.createReadStream(file), maxBytes);
  }

  private async commit(tmp: string, sha256: string, size: number): Promise<StoredBlob> {
    const target = this.pathOf(sha256);
    if (fs.existsSync(target)) {
      await fsp.rm(tmp, { force: true });
      return { sha256, size, existed: true };
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(tmp, target);
    await fsp.chmod(target, 0o440).catch(() => undefined);
    await this.fsyncDir(path.dirname(target));
    return { sha256, size, existed: false };
  }

  private async fsyncFile(file: string): Promise<void> {
    // 'r+': on Windows fsync is FlushFileBuffers, which refuses a read-only handle (EPERM).
    const fh = await fsp.open(file, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async fsyncDir(dir: string): Promise<void> {
    try {
      const fh = await fsp.open(dir, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      /* not supported on every platform/file system */
    }
  }

  async read(sha256: string): Promise<Buffer> {
    try {
      return await fsp.readFile(this.pathOf(sha256));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ArchiveError('The file of this document is missing in the store', 500, 'blob_missing');
      throw err;
    }
  }

  /** Recompute the hash of a blob. */
  async verify(sha256: string): Promise<boolean> {
    const hash = createHash('sha256');
    try {
      await pipeline(fs.createReadStream(this.pathOf(sha256)), hash);
      return hash.digest('hex') === sha256;
    } catch {
      return false;
    }
  }

  async remove(sha256: string): Promise<void> {
    const file = this.pathOf(sha256);
    await fsp.chmod(file, 0o640).catch(() => undefined);
    await fsp.rm(file, { force: true });
  }

  // ---------------------------------------------------------------- thumbnails

  thumbPath(documentId: number, version: number): string {
    // Ids are integers – checked anyway, and the path must stay inside the thumbnail directory.
    if (!Number.isSafeInteger(documentId) || !Number.isSafeInteger(version) || documentId < 0 || version < 0) throw new Error('Invalid document id or version');
    const root = path.resolve(this.thumbsDir);
    const file = path.resolve(root, `${documentId}-v${version}.webp`);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid thumbnail path');
    return file;
  }

  async removeThumbs(documentId: number): Promise<void> {
    const prefix = `${documentId}-v`;
    for (const f of await fsp.readdir(this.thumbsDir).catch(() => [] as string[])) if (f.startsWith(prefix)) await fsp.rm(path.join(this.thumbsDir, f), { force: true });
  }

  // ---------------------------------------------------------------- garbage collection

  /** All blob ids on disk. */
  async *listBlobs(): AsyncGenerator<{ sha256: string; mtimeMs: number }> {
    for (const a of await fsp.readdir(this.blobsDir).catch(() => [] as string[])) {
      for (const b of await fsp.readdir(path.join(this.blobsDir, a)).catch(() => [] as string[])) {
        for (const name of await fsp.readdir(path.join(this.blobsDir, a, b)).catch(() => [] as string[])) {
          if (!/^[0-9a-f]{64}$/.test(name)) continue;
          const st = await fsp.stat(path.join(this.blobsDir, a, b, name)).catch(() => null);
          if (st) yield { sha256: name, mtimeMs: st.mtimeMs };
        }
      }
    }
  }

  /**
   * Remove files that no database row knows (crash between rename and commit) and are older than
   * `minAgeMs`, and stale temp files. `known` answers whether a blob is recorded.
   */
  async gc(known: (sha256: string) => boolean, minAgeMs = 3_600_000): Promise<{ orphans: number; tmp: number }> {
    let orphans = 0;
    let tmp = 0;
    const now = Date.now();
    for await (const b of this.listBlobs()) {
      if (now - b.mtimeMs < minAgeMs || known(b.sha256)) continue;
      await this.remove(b.sha256);
      orphans++;
    }
    for (const name of await fsp.readdir(this.tmpDir).catch(() => [] as string[])) {
      const file = path.join(this.tmpDir, name);
      const st = await fsp.stat(file).catch(() => null);
      if (st && now - st.mtimeMs > 24 * 3_600_000) {
        await fsp.rm(file, { force: true });
        tmp++;
      }
    }
    if (orphans || tmp) log.info(`Blob store cleaned up: ${orphans} orphaned file(s), ${tmp} stale temp file(s)`);
    return { orphans, tmp };
  }

  /** Bytes used by the blobs (approximate, walks the store). */
  async size(): Promise<number> {
    let total = 0;
    for await (const b of this.listBlobs()) {
      const st = await fsp.stat(this.pathOf(b.sha256)).catch(() => null);
      total += st?.size ?? 0;
    }
    return total;
  }
}
