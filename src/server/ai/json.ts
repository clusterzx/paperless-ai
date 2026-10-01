/**
 * Robust extraction of a JSON object from LLM output.
 *
 * Models frequently wrap JSON in markdown fences, prepend reasoning
 * (`<think>…</think>`), add trailing commas or comments. This module tries
 * progressively more lenient strategies before giving up.
 */

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

/** Remove reasoning blocks some models (deepseek-r1, qwen3, …) emit. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // unterminated opening tag cut by the provider
    .trim();
}

/** Find the first balanced {...} block, respecting strings. */
export function findBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced (truncated output): return the remainder so repair can try closing it.
  return text.slice(start);
}

/** Best-effort repair of common JSON syntax mistakes. */
export function repairJson(input: string): string {
  let s = input
    .replace(/[“”„]/g, '"') // typographic double quotes
    .replace(/\/\/[^\n"]*$/gm, '') // line comments (outside strings, heuristically)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas

  // Close truncated structures.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) s += '"';
  if (stack.length) {
    s = s.replace(/,\s*$/, '');
    s += stack.reverse().join('');
  }
  return s.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse a JSON object from arbitrary model output.
 * @throws JsonExtractionError when nothing usable can be found.
 */
export function extractJsonObject<T = Record<string, unknown>>(raw: string): T {
  if (!raw || !raw.trim()) throw new JsonExtractionError('Empty response from AI model', raw ?? '');
  const text = stripReasoning(raw);

  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) candidates.push(m[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (isObject(direct)) return direct as T;
    const block = findBalancedObject(candidate);
    if (block) {
      const parsed = tryParse(block) ?? tryParse(repairJson(block));
      if (isObject(parsed)) return parsed as T;
    }
  }
  throw new JsonExtractionError('AI response did not contain valid JSON', raw);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
