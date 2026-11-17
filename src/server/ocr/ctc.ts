/**
 * Character dictionary and CTC decoding for PaddleOCR recognition models.
 */

/** Parse one YAML scalar of a block list entry (plain, 'single' or "double" quoted). */
function yamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
      if (/^[uUx]/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 16));
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', '/': '/', ' ': ' ', _: ' ' };
      return map[e] ?? e;
    });
  }
  return v;
}

/**
 * Read the `character_dict` list from a PaddleX inference.yml. Only the block-list form that
 * PaddleX writes is supported (`  - <char>` lines below `character_dict:`).
 */
export function parseCharacterDict(yml: string): string[] {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  if (start < 0) throw new Error('character_dict not found in inference.yml');
  const chars: string[] = [];
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^(\s*)- (.*)$/.exec(line);
    if (!m) {
      if (line.trim() === '') continue;
      break;
    }
    if (indent === null) indent = m[1].length;
    else if (m[1].length !== indent) break;
    chars.push(yamlScalar(m[2]));
  }
  if (!chars.length) throw new Error('character_dict in inference.yml is empty');
  return chars;
}

export interface Decoded {
  text: string;
  /** Mean probability of the recognised characters (0…1). */
  score: number;
}

/**
 * Greedy CTC decoding of a [batch, steps, classes] probability tensor. Class 0 is the blank,
 * classes 1…n map to `chars` (which must already include the trailing space character).
 */
export function ctcDecode(probs: Float32Array, batch: number, steps: number, classes: number, chars: string[]): Decoded[] {
  const out: Decoded[] = [];
  for (let b = 0; b < batch; b++) {
    let text = '';
    let sum = 0;
    let n = 0;
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      const base = (b * steps + t) * classes;
      let best = 0;
      let bestP = probs[base];
      for (let c = 1; c < classes; c++) {
        const p = probs[base + c];
        if (p > bestP) {
          bestP = p;
          best = c;
        }
      }
      if (best !== 0 && best !== prev) {
        text += chars[best - 1] ?? '';
        sum += bestP;
        n++;
      }
      prev = best;
    }
    out.push({ text, score: n ? sum / n : 0 });
  }
  return out;
}
