/**
 * Line diff of two texts (Myers' algorithm, O((N+M)·D)) – for comparing the text of two versions.
 */
export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** At most this many differences are computed; beyond that the texts count as rewritten. */
const MAX_EDITS = 4000;

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const max = Math.min(n + m, MAX_EDITS);
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[off + k] = i;
      if (i >= n && j >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return [...x.map((text) => ({ type: 'del' as const, text })), ...y.map((text) => ({ type: 'add' as const, text }))];
  // Walk back through the trace.
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  for (let d = trace.length - 1; d >= 0 && (i > 0 || j > 0); d--) {
    const vd = trace[d];
    const k = i - j;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevI = vd[off + prevK];
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      out.push({ type: 'same', text: x[--i] });
      j--;
    }
    if (d > 0) {
      if (i === prevI) out.push({ type: 'add', text: y[--j] });
      else out.push({ type: 'del', text: x[--i] });
    }
  }
  return out.reverse();
}
