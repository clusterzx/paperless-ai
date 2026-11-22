#!/usr/bin/env node
/**
 * Paperless-AI MCP bridge: connects an MCP client that starts a local program (stdio transport –
 * e.g. Hermes, Claude Desktop) with the MCP server of Paperless-AI (Streamable HTTP at /mcp).
 *
 *   node paperless-ai-mcp.mjs --url https://paperless-ai.example.com --key pai_…
 *   (or PAPERLESS_AI_URL / PAPERLESS_AI_API_KEY in the environment; --key-file <file> reads the key from a file)
 *
 * Inside the container: `paperless-ai mcp` (same options; the URL defaults to this server).
 * Needs Node.js 18 or newer, nothing else. Messages: one JSON-RPC message per line on stdin and
 * stdout; diagnostics on stderr.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: paperless-ai-mcp --url <Paperless-AI address> --key <API key with the MCP permission>  (or PAPERLESS_AI_URL, PAPERLESS_AI_API_KEY; --key-file <file>)';

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export function bridgeOptions(argv, env) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keyFile = arg('key-file') ?? env.PAPERLESS_AI_API_KEY_FILE;
  const key = (arg('key') ?? env.PAPERLESS_AI_API_KEY ?? (keyFile ? readFileSync(keyFile, 'utf8') : '')).trim();
  let url = (arg('url') ?? env.PAPERLESS_AI_URL ?? '').trim().replace(/\/+$/, '');
  if (url && !/\/mcp$/.test(url)) url += '/mcp';
  return { url, key };
}

/**
 * Forward lines of `input` to the server and its answers to `output` until `input` ends.
 * @param {{ url: string; key: string; input: NodeJS.ReadableStream; output: NodeJS.WritableStream; log?: (line: string) => void; fetchImpl?: typeof fetch }} o
 * @returns {Promise<number>} the exit code
 */
export async function runBridge(o) {
  const log = o.log ?? ((line) => process.stderr.write(`[paperless-ai-mcp] ${line}\n`));
  const doFetch = o.fetchImpl ?? fetch;
  if (!o.url || !o.key) {
    log(USAGE);
    return 2;
  }
  /** @type {string | null} */
  let protocolVersion = null;
  const write = (msg) => o.output.write(`${JSON.stringify(msg)}\n`);
  const fail = (id, message, code = -32000) => {
    if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code, message } });
    else log(message);
  };

  const send = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const id = message && typeof message === 'object' && !Array.isArray(message) ? message.id : undefined;
    let res;
    try {
      res = await doFetch(o.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${o.key}`,
          ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
        },
        body: line,
      });
    } catch (err) {
      fail(id, `Paperless-AI is not reachable at ${o.url}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (res.status === 202) return;
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    /** @type {unknown[]} */
    let answers = [];
    if (type.includes('text/event-stream')) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          answers.push(JSON.parse(data));
        } catch {}
      }
    } else if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        answers = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        answers = [];
      }
    }
    const rpc = answers.filter((a) => a && typeof a === 'object' && a.jsonrpc === '2.0');
    if (!res.ok && !rpc.length) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j.error ?? j.detail ?? detail;
      } catch {}
      const hint = res.status === 401 ? ' – check the API key' : res.status === 403 ? ' – the API key needs the MCP permission' : res.status === 429 ? ' – the rate limit of the API key' : '';
      fail(id, `Paperless-AI answered ${res.status}: ${detail}${hint}`);
      return;
    }
    for (const a of rpc) {
      if (a.result && typeof a.result.protocolVersion === 'string' && message && message.method === 'initialize') protocolVersion = a.result.protocolVersion;
      write(a);
    }
  };

  const pending = new Set();
  const rl = createInterface({ input: o.input, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    // The answer to initialize sets the protocol version for what follows: wait for it.
    let isInit = false;
    try {
      isInit = JSON.parse(line)?.method === 'initialize';
    } catch {}
    const p = send(line).finally(() => pending.delete(p));
    pending.add(p);
    if (isInit) await p;
  }
  await Promise.all(pending);
  return 0;
}

// Started as a program (node paperless-ai-mcp.mjs …), not imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url, key } = bridgeOptions(process.argv.slice(2), process.env);
  runBridge({ url, key, input: process.stdin, output: process.stdout }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[paperless-ai-mcp] ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}
