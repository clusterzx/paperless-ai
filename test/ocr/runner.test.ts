import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OcrRelease } from '../../src/shared/ocr.js';
import type { PipelineOptions } from '../../src/server/ocr/pipeline.js';
import { OcrWorkerEngine } from '../../src/server/ocr/runner.js';
import type { OcrWorkerMessage } from '../../src/server/ocr/worker.js';

const fakeWorker = fileURLToPath(new URL('../helpers/fakeOcrWorker.mjs', import.meta.url));
const realWorker = fileURLToPath(new URL('../../src/server/ocr/worker.ts', import.meta.url));

const options = (device: PipelineOptions['device']): PipelineOptions => ({
  cacheDir: '/nonexistent',
  language: 'latin',
  detector: 'mobile',
  device,
  threads: 1,
  detMaxSide: 960,
  pageOrientation: false,
  textlineOrientation: false,
  minScore: 0.5,
});
const render = { dpi: 200, maxPages: 0 };
const bytes = (text: string) => new TextEncoder().encode(text);
const pidOf = (text: string) => Number(/\(pid (\d+)\)/.exec(text)?.[1]);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const engines: OcrWorkerEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.dispose()));
});

function engine(device: PipelineOptions['device'], release: OcrRelease | (() => OcrRelease), idleMs = 60_000): OcrWorkerEngine {
  const e = new OcrWorkerEngine(options(device), {
    release: typeof release === 'function' ? release : () => release,
    idleMs,
    entry: fakeWorker,
    execArgv: [],
  });
  engines.push(e);
  return e;
}

describe('OCR worker process', () => {
  it('reads documents in a separate process', async () => {
    const e = engine('cpu', 'idle');
    const progress: number[] = [];
    const r = await e.run(bytes('hello'), render, (page) => progress.push(page));
    expect(r).toMatchObject({ provider: 'cpu', totalPages: 1, meanScore: 0.9 });
    expect(r.text).toMatch(/^read: hello/);
    expect(progress).toEqual([1]);
    expect(pidOf(r.text)).not.toBe(process.pid);
    expect(e.pid).toBe(pidOf(r.text));
  });

  it('frees the GPU memory before the AI analysis starts: the process is gone when the result arrives (#1005)', async () => {
    const e = engine('cuda', 'auto');
    const first = await e.run(bytes('invoice'), render);
    expect(e.provider).toBe('cuda');
    expect(e.pid).toBeNull();
    expect(alive(pidOf(first.text))).toBe(false);
    // the next document starts a fresh process
    const second = await e.run(bytes('letter'), render);
    expect(pidOf(second.text)).not.toBe(pidOf(first.text));
    expect(alive(pidOf(second.text))).toBe(false);
  });

  it('keeps the models loaded on the CPU in automatic mode and stops after the idle time', async () => {
    const e = engine('cpu', 'auto', 150);
    const first = await e.run(bytes('a'), render);
    const second = await e.run(bytes('b'), render);
    expect(pidOf(second.text)).toBe(pidOf(first.text));
    expect(e.pid).toBe(pidOf(first.text));
    await vi.waitFor(() => expect(e.pid).toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => expect(alive(pidOf(first.text))).toBe(false), { timeout: 3000 });
  });

  it('follows the setting: unload after each document even on the CPU, or keep the GPU models loaded', async () => {
    const cpu = engine('cpu', 'document');
    const r = await cpu.run(bytes('x'), render);
    expect(cpu.pid).toBeNull();
    expect(alive(pidOf(r.text))).toBe(false);

    const gpu = engine('cuda', 'idle');
    const g = await gpu.run(bytes('y'), render);
    expect(gpu.pid).toBe(pidOf(g.text));

    // a changed setting applies to the next document without a restart
    let mode: OcrRelease = 'idle';
    const live = engine('cuda', () => mode);
    const before = await live.run(bytes('1'), render);
    expect(live.pid).toBe(pidOf(before.text));
    mode = 'auto';
    const after = await live.run(bytes('2'), render);
    expect(pidOf(after.text)).toBe(pidOf(before.text));
    expect(live.pid).toBeNull();
  });

  it('unloads only when no other document is waiting', async () => {
    const e = engine('cuda', 'auto');
    const [slow, fast] = await Promise.all([e.run(bytes('slow one'), render), e.run(bytes('fast one'), render)]);
    expect(pidOf(fast.text)).toBe(pidOf(slow.text));
    expect(e.pid).toBeNull();
  });

  it('reports errors and survives a crashed process', async () => {
    const e = engine('cpu', 'idle');
    await expect(e.run(bytes('fail'), render)).rejects.toThrow('cannot read this file');
    const pid = e.pid;
    expect(pid).not.toBeNull();
    await expect(e.run(bytes('crash'), render)).rejects.toThrow(/OCR worker exited unexpectedly \(exit code 3\)/);
    expect(e.pid).toBeNull();
    const r = await e.run(bytes('again'), render);
    expect(pidOf(r.text)).not.toBe(pid);
  });

  it('settles without a test runner keeping the event loop alive', async () => {
    // An idle worker must not keep the server process alive, but ending one has to be awaited.
    const script = fileURLToPath(new URL('../helpers/ocrRunnerStandalone.ts', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', script], { timeout: 20_000 });
    expect(stdout.trim().split('\n')).toEqual([
      'cuda/auto: read: slow page, worker running: false',
      'cpu/document: read: slow page, worker running: false',
      'cpu/idle: read: slow page, worker running: true',
    ]);
  }, 30_000);

  it('ends the process on dispose', async () => {
    const e = engine('cpu', 'idle');
    const r = await e.run(bytes('a'), render);
    await e.dispose();
    expect(e.pid).toBeNull();
    expect(alive(pidOf(r.text))).toBe(false);
  });
});

describe('the real OCR worker script', () => {
  it('answers over IPC and ends when the server goes away', async () => {
    const child = fork(realWorker, [JSON.stringify({ ...options('cpu'), detector: 'none' })], {
      serialization: 'advanced',
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    try {
      // An unknown detector fails before any model download – enough to see the protocol work.
      child.send({ id: 7, bytes: bytes('%PDF-1.7'), render });
      const [msg] = (await once(child, 'message')) as [OcrWorkerMessage];
      expect(msg).toMatchObject({ type: 'error', id: 7 });
      const exited = once(child, 'exit');
      child.disconnect();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      child.kill();
    }
  }, 30_000);
});
