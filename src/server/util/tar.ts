/**
 * Extract a .tar.gz file (as npm packs packages): regular files and folders only, nothing outside
 * the target folder (no absolute paths, no "..", no links).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export interface ExtractOptions {
  /** Leading path parts to drop ("package/dist/x.js" → "dist/x.js" with 1). */
  strip?: number;
  /** Files to leave out (by their path after `strip`). */
  skip?: (file: string) => boolean;
}

const cstring = (b: Buffer, start: number, len: number) => {
  const end = b.indexOf(0, start);
  return b.toString('utf8', start, end < 0 || end > start + len ? start + len : end);
};

function octal(b: Buffer, start: number, len: number): number {
  // Large sizes use the base-256 form (first byte with the high bit set).
  if (b[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + b[i];
    return n;
  }
  const s = cstring(b, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** Records of a pax extended header ("<len> key=value\n"). */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let p = 0;
  while (p < data.length) {
    const space = data.indexOf(0x20, p);
    if (space < 0) break;
    const len = Number(data.toString('utf8', p, space));
    if (!len || p + len > data.length) break;
    const record = data.toString('utf8', space + 1, p + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    p += len;
  }
  return out;
}

/** The target of an entry inside `dest`, or null when it would leave it. */
function targetOf(dest: string, name: string, strip: number): string | null {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..') || name.startsWith('/')) return null;
  const rest = parts.slice(strip);
  if (!rest.length) return null;
  const target = path.resolve(dest, ...rest);
  return target.startsWith(path.resolve(dest) + path.sep) ? target : null;
}

/** Extract `archive` (.tar.gz) into `dest`. Returns the number of files written. */
export async function extractTarGz(archive: string, dest: string, opts: ExtractOptions = {}): Promise<number> {
  const strip = opts.strip ?? 0;
  await fsp.mkdir(dest, { recursive: true });
  let pending: Buffer = Buffer.alloc(0);
  let entry: { remaining: number; padding: number; fh: fsp.FileHandle | null; meta: Buffer[] | null; kind: string } | null = null;
  let longName: string | null = null;
  let paxHeaders: Record<string, string> = {};
  let files = 0;
  let ended = false;

  const finishEntry = async () => {
    if (!entry) return;
    if (entry.fh) await entry.fh.close();
    if (entry.meta) {
      const data = Buffer.concat(entry.meta);
      if (entry.kind === 'L') longName = cstring(data, 0, data.length);
      else if (entry.kind === 'x') paxHeaders = pax(data);
    }
    entry = null;
  };

  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      (async () => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (!ended) {
          if (entry) {
            if (entry.remaining > 0) {
              if (!pending.length) return;
              const part = pending.subarray(0, Math.min(entry.remaining, pending.length));
              if (entry.fh) await entry.fh.write(part);
              else if (entry.meta) entry.meta.push(Buffer.from(part));
              entry.remaining -= part.length;
              pending = pending.subarray(part.length);
              continue;
            }
            if (pending.length < entry.padding) return;
            pending = pending.subarray(entry.padding);
            await finishEntry();
            continue;
          }
          if (pending.length < 512) return;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (header.every((x) => x === 0)) {
            ended = true;
            return;
          }
          const kind = String.fromCharCode(header[156] || 0x30);
          const size = paxHeaders.size ? Number(paxHeaders.size) : octal(header, 124, 12);
          const prefix = header.toString('latin1', 257, 262) === 'ustar' ? cstring(header, 345, 155) : '';
          const name = paxHeaders.path ?? longName ?? (prefix ? `${prefix}/${cstring(header, 0, 100)}` : cstring(header, 0, 100));
          const padding = (512 - (size % 512)) % 512;
          const meta = kind === 'L' || kind === 'x';
          if (!meta) {
            longName = null;
            paxHeaders = {};
          }
          let fh: fsp.FileHandle | null = null;
          const target = meta ? null : targetOf(dest, name, strip);
          if (target && kind === '5') await fsp.mkdir(target, { recursive: true });
          else if (
            target &&
            (kind === '0' || kind === '7') &&
            !opts.skip?.(path.relative(dest, target).split(path.sep).join('/'))
          ) {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            fh = await fsp.open(target, 'w', 0o644);
            files++;
          }
          entry = { remaining: size, padding, fh, meta: meta ? [] : null, kind };
        }
      })().then(() => done(), done);
    },
    final(done) {
      finishEntry().then(() => done(), done);
    },
  });
  try {
    await pipeline(fs.createReadStream(archive), createGunzip(), sink);
  } finally {
    const open = entry as { fh: fsp.FileHandle | null } | null;
    await open?.fh?.close().catch(() => undefined);
  }
  return files;
}
