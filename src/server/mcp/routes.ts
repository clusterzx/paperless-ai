/**
 * The MCP server of Paperless-AI at /mcp (Model Context Protocol, Streamable HTTP transport): AI agents
 * and assistants (Claude, Hermes, OpenCode, Cursor …) search, read, ask, change and add documents.
 *
 * - Only personal API keys with the `mcp` scope; what the tools may do follows the key's other scopes
 *   and libraries (tools.ts). The key's rate limit applies (app.ts).
 * - Stateless: every POST carries JSON-RPC message(s) and gets the JSON answer; no server-sent
 *   events, no sessions (GET and DELETE answer 405, as the transport allows).
 * - Requests from web pages of other origins are refused (DNS rebinding protection of the spec).
 * - For clients that only start local programs (stdio): the bridge, bridge.mjs (`paperless-ai mcp`).
 */
import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../http/app.js';
import { userIdOf } from '../access/scope.js';
import { actorName } from '../access/context.js';
import { logger } from '../logger.js';
import { handleMessage, hasRequest, LATEST_PROTOCOL_VERSION, PROTOCOL_VERSIONS, RPC, RpcError, type RpcResponse } from './protocol.js';
import { callTool, inputSchema, toolsFor, type ToolContext } from './tools.js';

const log = logger.child({ module: 'mcp' });

const INSTRUCTIONS = [
  'Paperless-AI is a document archive (letters, invoices, contracts, receipts …) with AI analysis.',
  'Find documents with search_documents (words plus search syntax such as tag:, correspondent:, created:2024), then read one with get_document.',
  'For questions across many documents use ask_documents (answers with sources) when it is offered.',
  'Labels (tags, correspondents, document types, custom fields) are given by name; list_labels shows the existing ones.',
  'Dates are YYYY-MM-DD. Link documents for the user with their `url`.',
].join(' ');

/** The version of Paperless-AI (package.json), for serverInfo. */
let version = '0.0.0';
void readFile(new URL('../../../package.json', import.meta.url), 'utf8')
  .then((s) => (version = (JSON.parse(s) as { version: string }).version))
  .catch(() => undefined);

/** Same origin as the server (or none – agents send none). */
function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

const rpcError = (reply: FastifyReply, status: number, code: number, message: string) => reply.code(status).send({ jsonrpc: '2.0', id: null, error: { code, message } });

export const mcpRoutes =
  ({ ctx, rag }: Services): FastifyPluginAsync =>
  async (app) => {
    // JSON-RPC answers to bodies that are no JSON (instead of the API's error format).
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const text = String(body);
      if (!text.trim()) return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, { __parseError: true });
      }
    });

    // Room for an upload_document of the largest file allowed (base64 is a third larger).
    const bodyLimit = Math.ceil(ctx.cfg.archive.builtin.maxUploadMb * 1.4 + 2) * 1024 * 1024;
    app.post('/mcp', { config: { auth: 'user' }, bodyLimit }, async (req, reply) => {
      if (!originAllowed(req)) return rpcError(reply, 403, RPC.invalidRequest, 'Requests from other origins are not allowed');
      const scope = req.access!;
      // A personal API key: what it may do is set per key (sessions and the old global key are not for agents).
      if (scope.principal.kind !== 'user' || scope.principal.via !== 'apiKey') {
        return rpcError(reply, 403, RPC.invalidRequest, 'The MCP server needs a personal API key with the “MCP” permission (Settings → API keys)');
      }
      const requested = req.headers['mcp-protocol-version'];
      if (typeof requested === 'string' && requested && !(PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
        return rpcError(reply, 400, RPC.invalidRequest, `Unsupported MCP protocol version ${requested} (supported: ${PROTOCOL_VERSIONS.join(', ')})`);
      }
      const body = req.body as unknown;
      if (body === undefined) return rpcError(reply, 400, RPC.invalidRequest, 'The body is empty');
      if (body && typeof body === 'object' && (body as { __parseError?: boolean }).__parseError) return rpcError(reply, 400, RPC.parseError, 'Parse error: the body is no valid JSON');

      // The client went away: stop what still runs for it (the AI answer).
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const t: ToolContext = { ctx, rag, scope, origin: { actor: 'user', actorId: userIdOf(scope), ref: 'mcp' }, signal: abort.signal };

      const handle = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        switch (method) {
          case 'initialize': {
            const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
            const client = (params.clientInfo as { name?: string; version?: string } | undefined) ?? {};
            log.info(`MCP client ${client.name ?? 'unknown'} ${client.version ?? ''} connected as ${actorName(scope)}`);
            return {
              protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'paperless-ai', title: 'Paperless-AI', version },
              instructions: INSTRUCTIONS,
            };
          }
          case 'ping':
            return {};
          case 'tools/list':
            return {
              tools: toolsFor(t).map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: inputSchema(tool),
                annotations: { title: tool.title, ...tool.annotations },
              })),
            };
          case 'tools/call': {
            const name = String(params.name ?? '');
            const tool = toolsFor(t).find((x) => x.name === name);
            if (!tool) throw new RpcError(RPC.invalidParams, `Unknown tool: ${name || '(none)'} – or the API key may not use it`);
            const started = Date.now();
            const result = await callTool(tool, params.arguments, t);
            log.info(`MCP ${name} by ${actorName(scope)}: ${result.isError ? `error – ${result.content[0]?.text.slice(0, 200)}` : 'ok'} (${Date.now() - started} ms)`);
            return result;
          }
          // Nothing of these here – empty lists, so clients that ask anyway are content.
          case 'resources/list':
            return { resources: [] };
          case 'resources/templates/list':
            return { resourceTemplates: [] };
          case 'prompts/list':
            return { prompts: [] };
          case 'logging/setLevel':
            return {};
          default:
            throw new RpcError(RPC.methodNotFound, `Method not found: ${method}`);
        }
      };

      if (Array.isArray(body)) {
        if (!body.length) return rpcError(reply, 400, RPC.invalidRequest, 'Empty batch');
        const answers = (await Promise.all(body.map((m) => handleMessage(m, handle)))).filter((a): a is RpcResponse => a !== null);
        if (!hasRequest(body)) return reply.code(202).send();
        return reply.header('Content-Type', 'application/json').send(answers);
      }
      const answer = await handleMessage(body, handle);
      if (!answer) return reply.code(202).send();
      return reply.header('Content-Type', 'application/json').send(answer);
    });

    // No stream of server messages and no sessions (Streamable HTTP allows both answers).
    const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: 'Method not allowed – send JSON-RPC messages with POST' } });
    app.get('/mcp', notAllowed);
    app.delete('/mcp', notAllowed);

    // The stdio bridge for clients that start a local program (no account needed to download it).
    app.get('/mcp/bridge.mjs', { config: { auth: 'public' } }, async (_req, reply) => {
      const file = await readFile(new URL('./bridge.mjs', import.meta.url), 'utf8');
      return reply.type('text/javascript; charset=utf-8').header('Content-Disposition', 'attachment; filename="paperless-ai-mcp.mjs"').send(file);
    });
  };
