import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppContext } from '../../src/server/context.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { makePdf } from '../helpers/pdf.js';
import { backendContract, type SeedDoc } from './contract.js';

export async function builtinFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-builtin-'));
  const ctx = new AppContext({ dataDir, env: {}, memoryDb: true });
  ctx.config.update({ archive: { mode: 'builtin' }, processing: { automatic: false } });
  const backend = ctx.archive() as LocalBackend;
  return {
    ctx,
    backend,
    async seed(docs: SeedDoc[]) {
      const ids: number[] = [];
      for (const d of docs) {
        const file = d.file ?? { data: makePdf([[d.title, ...d.content.match(/.{1,80}(\s|$)/g)!.map((l) => l.trim())]]), contentType: 'application/pdf', filename: `${d.title}.pdf` };
        const res = await backend.ingest(SYSTEM_SCOPE, { data: file.data, filename: file.filename }, 'import', {
          title: d.title,
          created: d.created,
          tags: d.tags,
          correspondent: d.correspondent,
          documentType: d.documentType,
        });
        if (res.status !== 'stored') throw new Error(`Seeding failed: ${res.status} ${res.reason}`);
        ids.push(res.documentId!);
      }
      return ids;
    },
    async close() {
      await backend.close();
      ctx.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

backendContract('built-in archive', builtinFixture);
