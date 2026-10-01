import { describe, expect, it } from 'vitest';
import { runTransform } from '../../src/server/processing/externalApi.js';

describe('runTransform', () => {
  const data = { items: [{ name: 'ACME' }, { name: 'Globex' }] };

  it('accepts function bodies, functions and arrow functions', async () => {
    expect(await runTransform('return data.items.map((i) => i.name)', data)).toEqual(['ACME', 'Globex']);
    expect(await runTransform('function transform(d) { return d.items.length }', data)).toBe(2);
    expect(await runTransform('(d) => d.items[0]', data)).toEqual({ name: 'ACME' });
    expect(await runTransform('async (d) => { await null; return d.items[1].name }', data)).toBe('Globex');
    expect(await runTransform('', data)).toBe(data);
    expect(await runTransform('return undefined', data)).toBeUndefined();
  });

  it('stops endless transforms – synchronous and asynchronous – without blocking the server', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      await expect(runTransform('while (true) {}', data, 500)).rejects.toThrow(/did not finish|timed out/);
      await expect(runTransform('async function (d) { await null; for (;;) {} }', data, 500)).rejects.toThrow(/did not finish/);
    } finally {
      clearInterval(timer);
    }
    // the event loop of the server kept running meanwhile
    expect(ticks).toBeGreaterThan(20);
  });

  it('reports errors and has no access to the environment of the app', async () => {
    process.env.PAI_TEST_SECRET = 'secret';
    try {
      await expect(runTransform('throw new Error("boom")', data)).rejects.toThrow('Transform failed: boom');
      expect(await runTransform('return data.constructor.constructor("return process.env.PAI_TEST_SECRET")()', data)).toBeUndefined();
      await expect(runTransform('return new Promise(() => {})', data)).rejects.toThrow(/did not return a result/);
    } finally {
      delete process.env.PAI_TEST_SECRET;
    }
  });
});
