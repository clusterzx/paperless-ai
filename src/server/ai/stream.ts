/**
 * Incremental parsers for streaming HTTP responses.
 */

/** Split a byte stream into text lines (handles \r\n and chunk boundaries). */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a text/event-stream body into events. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(body)) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) yield { event, data: data.join('\n') };
}

/** Parse newline-delimited JSON (Ollama streaming format). */
export async function* parseNdjson<T = unknown>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as T;
  }
}

/**
 * Removes `<think>…</think>` reasoning blocks from a streamed answer, even
 * when the tags are split across chunks. Text before an opening tag is kept.
 */
export class ThinkFilter {
  private buffer = '';
  private inside = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = this.buffer.indexOf('</think>');
        if (end < 0) {
          // Keep a possible partial closing tag, drop the reasoning text.
          this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 7));
          return out;
        }
        this.buffer = this.buffer.slice(end + 8);
        this.inside = false;
        continue;
      }
      const start = this.buffer.indexOf('<think>');
      if (start >= 0) {
        out += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + 7);
        this.inside = true;
        continue;
      }
      // Hold back a trailing fragment that could be the beginning of "<think>".
      let keep = 0;
      for (let n = Math.min(6, this.buffer.length); n > 0; n--) {
        if ('<think>'.startsWith(this.buffer.slice(-n))) {
          keep = n;
          break;
        }
      }
      out += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return out;
    }
  }

  /** Remaining text at the end of the stream. */
  flush(): string {
    const rest = this.inside ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }
}
