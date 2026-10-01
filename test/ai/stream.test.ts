import { describe, expect, it } from 'vitest';
import { parseNdjson, parseSse, readLines, ThinkFilter } from '../../src/server/ai/stream.js';

/** Build a byte stream from string pieces (simulating network chunk boundaries). */
function streamOf(pieces: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

/** Split a string into chunks of n characters. */
function chunks(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

describe('readLines', () => {
  it('splits lines across chunk boundaries and handles CRLF', async () => {
    const lines = await collect(readLines(streamOf(['first li', 'ne\r\nsec', 'ond\n', '\nlast'])));
    expect(lines).toEqual(['first line', 'second', '', 'last']);
  });

  it('decodes multi-byte UTF-8 characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('Grüße 漢字\n');
    const pieces = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await collect(readLines(streamOf(pieces)))).toEqual(['Grüße 漢字']);
  });
});

describe('parseSse', () => {
  const body =
    ': comment\n' +
    'data: {"a":1}\n\n' +
    'event: custom\ndata: line1\ndata: line2\n\n' +
    'data:no-space\n\n' +
    'id: 5\nretry: 100\n\n' +
    'data: [DONE]\n\n';

  for (const size of [1, 3, 7, 1000]) {
    it(`parses events with chunk size ${size}`, async () => {
      const events = await collect(parseSse(streamOf(chunks(body, size))));
      expect(events).toEqual([
        { event: undefined, data: '{"a":1}' },
        { event: 'custom', data: 'line1\nline2' },
        { event: undefined, data: 'no-space' },
        { event: undefined, data: '[DONE]' },
      ]);
    });
  }

  it('emits a trailing event without final blank line', async () => {
    expect(await collect(parseSse(streamOf(['data: tail'])))).toEqual([{ event: undefined, data: 'tail' }]);
  });

  it('handles CRLF line endings', async () => {
    expect(await collect(parseSse(streamOf(['data: x\r\n\r\ndata: y\r\n\r\n'])))).toEqual([
      { event: undefined, data: 'x' },
      { event: undefined, data: 'y' },
    ]);
  });
});

describe('parseNdjson', () => {
  it('parses objects across chunk boundaries and skips blank lines', async () => {
    const body = '{"message":{"content":"Hel"},"done":false}\n\n{"message":{"content":"lo"},"done":false}\n{"done":true,"eval_count":3}';
    for (const size of [1, 5, 1000]) {
      const items = await collect(parseNdjson<{ done: boolean }>(streamOf(chunks(body, size))));
      expect(items).toHaveLength(3);
      expect(items[2]).toEqual({ done: true, eval_count: 3 });
    }
  });

  it('throws on invalid JSON lines', async () => {
    await expect(collect(parseNdjson(streamOf(['{"ok":1}\nnot json\n'])))).rejects.toThrow();
  });
});

describe('ThinkFilter', () => {
  const run = (chunks: string[]) => {
    const f = new ThinkFilter();
    return chunks.map((c) => f.push(c)).join('') + f.flush();
  };

  it('passes text without reasoning through unchanged', () => {
    expect(run(['Hello ', 'world', '!'])).toBe('Hello world!');
  });

  it('removes a reasoning block inside one chunk and keeps text before it', () => {
    expect(run(['Answer: <think>secret</think>42'])).toBe('Answer: 42');
  });

  it('handles tags split across chunks', () => {
    expect(run(['<th', 'ink>let me', ' think</th', 'ink>', 'Result'])).toBe('Result');
    expect(run(['Intro <', 't', 'hink>x', '</', 'think> done'])).toBe('Intro  done');
  });

  it('does not swallow a lone "<" that is not a tag', () => {
    expect(run(['a <', ' b'])).toBe('a < b');
    expect(run(['value <'])).toBe('value <');
  });

  it('drops an unterminated reasoning block', () => {
    expect(run(['ok <think>never closed'])).toBe('ok ');
  });
});
