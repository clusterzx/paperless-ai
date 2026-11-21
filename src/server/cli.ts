#!/usr/bin/env node
/**
 * Command line of Paperless-AI for long-running archive work (docs/standalone/migration.md):
 *
 *   paperless-ai migrate analyse
 *   paperless-ai migrate plan    --strategy single:<library> | owner:<shared library> [--archived] [--no-create-users] [--analyze]
 *   paperless-ai migrate start   (same options) – imports and waits until it is done
 *   paperless-ai migrate sync | status | discard
 *   paperless-ai migrate cutover – stop the server first (it switches the archive mode)
 *   paperless-ai export --format ngx|plain --out <directory> [--library <id> …]
 *
 * Uses the data directory of the server (PAPERLESS_AI_DATA_DIR or ./data, or --data <dir>).
 */
import './env.js';
import path from 'node:path';
import { AppContext } from './context.js';
import { MigrationService } from './migration/service.js';
import { exportArchive } from './migration/export.js';
import { LocalBackend } from './archive/backend.js';
import type { MigrationOptions, MigrationStrategy } from '../shared/migration.js';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function args(all: string[], name: string): string[] {
  return all.flatMap((a, i) => (a === `--${name}` && all[i + 1] ? [all[i + 1]] : []));
}

function strategyOf(a: string[]): MigrationStrategy {
  const s = arg(a, 'strategy') ?? 'single:Archive';
  const [kind, ...rest] = s.split(':');
  const name = rest.join(':') || (kind === 'owner' ? 'Shared' : 'Archive');
  if (kind === 'owner') return { kind: 'owner', sharedName: name };
  if (kind === 'single') return { kind: 'single', libraryName: name };
  throw new Error(`Unknown strategy "${kind}" – single:<library> or owner:<shared library> (rules: in the web interface)`);
}

function optionsOf(a: string[]): MigrationOptions {
  return { archived: a.includes('--archived'), createUsers: !a.includes('--no-create-users'), concurrency: Number(arg(a, 'concurrency') ?? 4), analyze: a.includes('--analyze') };
}

const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, (_, x) => (x instanceof Map ? undefined : x), 2)}\n`);

const USAGE = `Usage:
  paperless-ai migrate analyse|plan|start|sync|status|cutover|discard [--strategy single:<name>|owner:<shared>] [--archived] [--no-create-users] [--concurrency n] [--analyze]
  paperless-ai export --format ngx|plain --out <directory> [--library <id> …]
Options: --data <directory> (default: PAPERLESS_AI_DATA_DIR or ./data)`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const all = [sub ?? '', ...rest];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 0 : 1;
  }
  const dataDir = path.resolve(arg(all, 'data') ?? process.env.PAPERLESS_AI_DATA_DIR ?? path.join(process.cwd(), 'data'));
  const ctx = new AppContext({ dataDir });
  try {
    if (cmd === 'migrate') {
      const m = new MigrationService(ctx);
      try {
        switch (sub) {
          case 'analyse':
          case 'analyze':
            print(await m.analyse());
            break;
          case 'plan': {
            const { libraries, users, widened } = await m.plan(strategyOf(all), optionsOf(all));
            print({ libraries, users, widened });
            break;
          }
          case 'start': {
            await m.start(strategyOf(all), optionsOf(all));
            const timer = setInterval(() => {
              const s = m.status().counts;
              process.stderr.write(`\r${s.imported}/${s.total} imported, ${s.failed} failed`);
            }, 2000);
            await m.wait();
            clearInterval(timer);
            process.stderr.write('\n');
            print(m.status());
            break;
          }
          case 'sync':
            print(await m.sync());
            break;
          case 'status':
            print(m.status());
            break;
          case 'cutover':
            print(await m.cutover({}));
            break;
          case 'discard':
            await m.discard();
            print(m.status());
            break;
          default:
            process.stderr.write(`${USAGE}\n`);
            return 1;
        }
      } finally {
        await m.close();
      }
      return 0;
    }
    if (cmd === 'export') {
      const format = arg(all, 'format') as 'ngx' | 'plain' | undefined;
      const out = arg(all, 'out');
      if (!format || !['ngx', 'plain'].includes(format) || !out) {
        process.stderr.write(`${USAGE}\n`);
        return 1;
      }
      const backend = new LocalBackend(ctx, { passive: true });
      try {
        const libs = args(all, 'library').map(Number);
        print(await exportArchive(ctx, backend.blobs, { format, directory: out, libraryIds: libs.length ? libs : null }));
      } finally {
        await backend.close();
      }
      return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    ctx.close();
  }
}

// Run when called as a program (not when imported by tests).
if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
