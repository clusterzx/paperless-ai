/**
 * Runs the transform of the external API (externalApi.ts) in a worker thread – inside QuickJS, a
 * JavaScript engine compiled to WebAssembly. Unlike node:vm this is a real sandbox: the code sees
 * only the plain JSON data it gets and the built-ins of the language (no Node.js, no files, no
 * network, no process), within a memory limit and a deadline.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSSyncVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

const MEMORY_LIMIT = 64 * 1024 * 1024;

interface Job {
  /** Expression that evaluates to the transform function. */
  fn: string;
  json: string;
  timeoutMs: number;
}

type Result = { ok: true; json?: string } | { ok: false; error: string };

/** QuickJS stops the code at the deadline with "interrupted". */
const explained = (error: string, timeoutMs: number) =>
  /interrupted/i.test(error) ? `The transform did not finish within ${timeoutMs / 1000} s` : error;

async function run(job: Job): Promise<Result> {
  const res = await evaluate(job);
  return res.ok ? res : { ok: false, error: explained(res.error, job.timeoutMs) };
}

async function evaluate({ fn, json, timeoutMs }: Job): Promise<Result> {
  // A CommonJS package: depending on the module resolution its default export arrives wrapped (the engine unwraps it).
  const quickjs = await newQuickJSWASMModuleFromVariant(variant as unknown as QuickJSSyncVariant);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = runtime.newContext();
  try {
    vm.newString(json).consume((h) => vm.setProp(vm.global, '__json', h));
    // The result leaves the sandbox as JSON text only.
    const script = `(async () => {
      const __fn = ${fn}
      ;const __r = await __fn(JSON.parse(globalThis.__json));
      globalThis.__out = __r === undefined ? undefined : JSON.stringify(__r);
      globalThis.__done = true;
    })().catch((e) => { globalThis.__err = String((e && e.message) || e); globalThis.__done = true; });`;
    const evaluated = vm.evalCode(script, 'transform.js');
    if (evaluated.error) {
      const err = vm.dump(evaluated.error) as { message?: string } | string;
      evaluated.error.dispose();
      return { ok: false, error: typeof err === 'string' ? err : (err?.message ?? String(err)) };
    }
    evaluated.value.dispose();
    const jobs = runtime.executePendingJobs(-1);
    if (jobs.error) {
      const err = vm.dump(jobs.error) as { message?: string } | string;
      jobs.error.dispose();
      return { ok: false, error: typeof err === 'string' ? err : (err?.message ?? String(err)) };
    }
    const read = (name: string) => vm.getProp(vm.global, name).consume((h) => vm.dump(h) as unknown);
    if (read('__done') !== true) return { ok: false, error: 'it did not return a result' };
    const error = read('__err');
    if (typeof error === 'string') return { ok: false, error };
    const out = read('__out');
    return { ok: true, json: typeof out === 'string' ? out : undefined };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

run(workerData as Job).then(
  (msg) => parentPort!.postMessage(msg),
  (err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
