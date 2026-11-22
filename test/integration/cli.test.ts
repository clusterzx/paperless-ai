/** The command line: export of the built-in archive, migration status. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import { AppContext } from '../../src/server/context.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { main } from '../../src/server/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('command line', () => {
  it('exports the built-in archive and shows the migration status', async () => {
    const data = makeTempDir();
    dirs.push(data);
    const ctx = new AppContext({ dataDir: data, env: { PAPERLESS_AI_ARCHIVE: 'builtin', PAPERLESS_AI_NO_WATCHERS: '1' } });
    const b = ctx.archive() as LocalBackend;
    await b.ingest(SYSTEM_SCOPE, { data: makePdf([['Kontoauszug Januar']]), filename: 'konto.pdf' }, 'api', { title: 'Kontoauszug Januar', created: '2024-01-31', skipAnalysis: true });
    await b.close();
    ctx.close();

    const out = path.join(data, 'out');
    const write = process.stdout.write.bind(process.stdout);
    const printed: string[] = [];
    process.stdout.write = ((s: string) => (printed.push(String(s)), true)) as typeof process.stdout.write;
    try {
      expect(await main(['export', '--format', 'plain', '--out', out, '--data', data])).toBe(0);
      expect(await main(['migrate', 'status', '--data', data])).toBe(0);
      expect(await main(['nonsense', '--data', data])).toBe(1);
    } finally {
      process.stdout.write = write;
    }
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'metadata.json'), 'utf8')) as { title: string; file: string }[];
    expect(meta.map((m) => m.title)).toEqual(['Kontoauszug Januar']);
    expect(fs.existsSync(path.join(out, meta[0].file))).toBe(true);
    expect(JSON.parse(printed[0])).toMatchObject({ format: 'plain', documents: 1, files: 1 });
    expect(JSON.parse(printed[1])).toMatchObject({ state: 'idle', counts: { total: 0 } });
  });
});
