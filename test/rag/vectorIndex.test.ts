import { describe, expect, it } from 'vitest';
import { fromBlob, normalize, toBlob, VectorIndex } from '../../src/server/rag/vectorIndex.js';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number, dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = rand() * 2 - 1;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

describe('VectorIndex', () => {
  it('matches a brute-force float cosine search', () => {
    const rand = rng(42);
    const dims = 48;
    const index = new VectorIndex();
    const vectors = new Map<number, { doc: number; v: Float32Array }>();
    for (let id = 1; id <= 1500; id++) {
      const v = randomVector(rand, dims);
      vectors.set(id, { doc: Math.ceil(id / 5), v });
      index.add(id, Math.ceil(id / 5), v);
    }
    expect(index.count).toBe(1500);
    expect(index.dimensions).toBe(dims);

    for (let q = 0; q < 20; q++) {
      const query = randomVector(rand, dims);
      const truth = [...vectors.entries()].map(([id, { v }]) => ({ id, score: cosine(query, v) })).sort((a, b) => b.score - a.score);
      const hits = index.search(query, 10);
      expect(hits).toHaveLength(10);
      // sorted, scores close to the exact cosine
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
      for (const h of hits) {
        expect(Math.abs(h.score - cosine(query, vectors.get(h.id)!.v))).toBeLessThan(0.03);
        expect(h.documentId).toBe(vectors.get(h.id)!.doc);
      }
      // quantisation may only swap near-ties
      const tenth = truth[9].score;
      for (const h of hits) expect(cosine(query, vectors.get(h.id)!.v)).toBeGreaterThan(tenth - 0.03);
      expect(hits.slice(0, 3).map((h) => h.id)).toContain(truth[0].id);
    }
  });

  it('finds an exact copy with score ~1 and ignores the vector magnitude', () => {
    const index = new VectorIndex();
    const rand = rng(1);
    const target = randomVector(rand, 16);
    index.add(1, 1, randomVector(rand, 16));
    index.add(2, 2, target.map((x) => x * 10));
    index.add(3, 3, randomVector(rand, 16));
    const [best] = index.search(target, 1);
    expect(best.id).toBe(2);
    expect(best.score).toBeCloseTo(1, 1);
  });

  it('restricts the search to allowed documents', () => {
    const rand = rng(7);
    const index = new VectorIndex();
    for (let id = 1; id <= 100; id++) index.add(id, id % 10, randomVector(rand, 8));
    const hits = index.search(randomVector(rand, 8), 50, new Set([3, 4]));
    expect(hits).toHaveLength(20);
    for (const h of hits) expect([3, 4]).toContain(h.documentId);
    expect(index.search(randomVector(rand, 8), 5, new Set())).toEqual([]);
  });

  it('swap-remove keeps the id → slot mapping consistent', () => {
    const rand = rng(3);
    const index = new VectorIndex();
    const vs = new Map<number, Float32Array>();
    for (let id = 1; id <= 6; id++) {
      const v = randomVector(rand, 12);
      vs.set(id, v);
      index.add(id, 100 + id, v);
    }
    index.remove(2); // middle: the last vector (6) moves into its slot
    index.remove(99); // unknown: no-op
    expect(index.count).toBe(5);
    expect(index.has(2)).toBe(false);
    for (const id of [1, 3, 4, 5, 6]) {
      expect(index.has(id)).toBe(true);
      const [hit] = index.search(vs.get(id)!, 1);
      expect(hit).toMatchObject({ id, documentId: 100 + id });
    }
    index.remove(6); // the moved vector can be removed by id
    index.remove(5); // and the (new) last one
    expect(index.count).toBe(3);
    for (const id of [1, 3, 4]) expect(index.search(vs.get(id)!, 1)[0].id).toBe(id);
    expect(index.search(vs.get(6)!, 3).map((h) => h.id).sort()).toEqual([1, 3, 4]);

    // re-adding an existing id replaces its vector
    index.add(1, 101, vs.get(3)!);
    expect(index.count).toBe(3);
    const hits = index.search(vs.get(3)!, 2).map((h) => h.id).sort();
    expect(hits).toEqual([1, 3]);
  });

  it('removes all vectors of a document', () => {
    const rand = rng(5);
    const index = new VectorIndex();
    for (let id = 1; id <= 30; id++) index.add(id, id % 3, randomVector(rand, 8));
    index.removeDocument(1);
    expect(index.count).toBe(20);
    for (const h of index.search(randomVector(rand, 8), 30)) expect(h.documentId).not.toBe(1);
  });

  it('grows beyond the initial capacity', () => {
    const rand = rng(9);
    const index = new VectorIndex();
    const vs: Float32Array[] = [];
    for (let id = 0; id < 2600; id++) {
      vs.push(randomVector(rand, 8));
      index.add(id, id, vs[id]);
    }
    expect(index.count).toBe(2600);
    for (const id of [0, 1023, 1024, 1536, 2599]) expect(index.search(vs[id], 1)[0].id).toBe(id);
    expect(index.memoryBytes).toBeGreaterThan(2600 * 8);
  });

  it('validates dimensions and handles edge cases', () => {
    const index = new VectorIndex();
    expect(index.search(new Float32Array([1, 0]), 5)).toEqual([]);
    index.add(1, 1, new Float32Array([1, 0, 0]));
    expect(() => index.add(2, 2, new Float32Array([1, 0]))).toThrow(/3/);
    expect(index.search(new Float32Array([1, 0]), 5)).toEqual([]);
    expect(index.search(new Float32Array([1, 0, 0]), 10)).toHaveLength(1);
    index.add(3, 3, new Float32Array([0, 0, 0]));
    expect(index.search(new Float32Array([0, 1, 0]), 10)).toHaveLength(2);
    index.clear();
    expect(index.count).toBe(0);
    index.add(4, 4, new Float32Array([1, 2])); // new dimensionality after clear
    expect(index.dimensions).toBe(2);
  });
});

describe('vector helpers', () => {
  it('normalize returns unit vectors', () => {
    const v = normalize(new Float32Array([3, 4]));
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    const zero = new Float32Array([0, 0]);
    expect(normalize(zero)).toBe(zero);
  });

  it('blob round trip (also from unaligned buffers)', () => {
    const v = new Float32Array([1.5, -2.25, 3.125]);
    expect([...fromBlob(toBlob(v))]).toEqual([1.5, -2.25, 3.125]);
    const unaligned = Buffer.concat([Buffer.from([0]), toBlob(v)]).subarray(1);
    expect([...fromBlob(unaligned)]).toEqual([1.5, -2.25, 3.125]);
  });
});
