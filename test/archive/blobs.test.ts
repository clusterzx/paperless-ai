import fsp from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobStore } from '../../src/server/archive/blobs.js';
import { makeTempDir } from '../helpers/appHarness.js';

afterEach(() => vi.restoreAllMocks());

describe('BlobStore', () => {
  it('stores files where fsync needs a writable handle (Windows, #1049)', async () => {
    // As on Windows: FlushFileBuffers – and so sync() – fails with EPERM on a read-only handle of a file.
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (file, flags, mode) => {
      const fh = await open(file, flags, mode);
      const stat = await fh.stat();
      if ((flags ?? 'r') === 'r' && stat.isFile()) {
        fh.sync = async () => {
          throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });
        };
      }
      return fh;
    });
    const store = new BlobStore(makeTempDir());
    const stored = await store.putBytes(Buffer.from('Rechnung 42'));
    expect(stored.existed).toBe(false);
    expect((await store.read(stored.sha256)).toString()).toBe('Rechnung 42');
  });
});
