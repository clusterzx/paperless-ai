/**
 * The Model Context Protocol (MCP) over JSON-RPC 2.0: the messages the server answers. Transport:
 * Streamable HTTP without server-sent events (each POST gets its JSON answer) and without sessions –
 * see routes.ts. Spec: https://modelcontextprotocol.io/specification
 */

/** Newest first. A client asking for another version gets the newest (it may then disconnect). */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export type JsonRpcId = string | number;

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type MethodHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const isId = (v: unknown): v is JsonRpcId => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/**
 * One JSON-RPC message: the answer to a request, or null for notifications and responses (which
 * this server, never asking the client anything, only takes note of).
 */
export async function handleMessage(message: unknown, handle: MethodHandler): Promise<RpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: 'Invalid request: a JSON-RPC 2.0 object is expected' } };
  }
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
  const hasId = 'id' in m && m.id !== undefined;
  // A response of the client (to a request we never send) or a notification: nothing to answer.
  if (typeof m.method !== 'string') {
    if (hasId && ('result' in m || 'error' in m)) return null;
    return { jsonrpc: '2.0', id: isId(m.id) ? m.id : null, error: { code: RPC.invalidRequest, message: 'Invalid request: "method" is missing' } };
  }
  if (m.jsonrpc !== '2.0') {
    return hasId ? { jsonrpc: '2.0', id: isId(m.id) ? m.id : null, error: { code: RPC.invalidRequest, message: 'Invalid request: "jsonrpc" must be "2.0"' } } : null;
  }
  if (!hasId) {
    // Notifications (initialized, cancelled, roots changed …): no answer.
    return null;
  }
  if (!isId(m.id)) return { jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: 'Invalid request: "id" must be a string or a number' } };
  const params = m.params === undefined || m.params === null ? {} : m.params;
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { jsonrpc: '2.0', id: m.id, error: { code: RPC.invalidParams, message: 'Invalid params: an object is expected' } };
  }
  try {
    const result = await handle(m.method, params as Record<string, unknown>);
    return { jsonrpc: '2.0', id: m.id, result };
  } catch (err) {
    if (err instanceof RpcError) return { jsonrpc: '2.0', id: m.id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
    return { jsonrpc: '2.0', id: m.id, error: { code: RPC.internalError, message: err instanceof Error ? err.message : String(err) } };
  }
}

/** Whether a message (or a batch) contains a request that needs an answer. */
export function hasRequest(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body];
  return list.some((m) => m && typeof m === 'object' && typeof (m as { method?: unknown }).method === 'string' && (m as { id?: unknown }).id !== undefined);
}
