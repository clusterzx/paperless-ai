/**
 * Compact in-memory vector index.
 *
 * Vectors are L2-normalised and stored as int8 with a per-vector scale (4× smaller than float32),
 * plus one sign bit per dimension. Small indexes are searched exactly (int8 dot products). Large
 * ones first rank all vectors by the Hamming distance of their sign bits (32 dimensions per
 * popcount) and rescore the best candidates exactly – about 12× faster at 1M passages, with
 * practically the same result (docs/standalone/search-and-scale.md §2.2).
 */

export interface VectorHit {
  id: number;
  documentId: number;
  score: number;
}

export function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (!norm || Math.abs(norm - 1) < 1e-4) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Header of the int8 storage format ('PQ8', version 1), followed by a float32 scale and the int8
 * values. Earlier versions stored plain float32 – a float32 starting with these bytes would be about
 * 3e-38, which never occurs as an embedding component.
 */
const Q8_MAGIC = Buffer.from([0x50, 0x51, 0x38, 0x01]);
const Q8_HEADER = 8;

/** Stored form of an embedding: normalised and quantised to int8 (≈ ¼ of float32). */
export function toBlob(v: Float32Array): Buffer {
  const n = normalize(v);
  let max = 0;
  for (let i = 0; i < n.length; i++) max = Math.max(max, Math.abs(n[i]));
  const scale = max > 0 ? max / 127 : 1;
  const buf = Buffer.alloc(Q8_HEADER + n.length);
  Q8_MAGIC.copy(buf, 0);
  buf.writeFloatLE(scale, 4);
  for (let i = 0; i < n.length; i++) buf.writeInt8(Math.round(n[i] / scale), Q8_HEADER + i);
  return buf;
}

/** Whether a stored embedding uses the int8 format (older indexes stored float32). */
export function isQuantizedBlob(b: Uint8Array): boolean {
  return b.byteLength > Q8_HEADER && b[0] === Q8_MAGIC[0] && b[1] === Q8_MAGIC[1] && b[2] === Q8_MAGIC[2] && b[3] === Q8_MAGIC[3];
}

export function fromBlob(b: Buffer | Uint8Array): Float32Array {
  if (isQuantizedBlob(b)) {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    const scale = buf.readFloatLE(4);
    const out = new Float32Array(b.byteLength - Q8_HEADER);
    for (let i = 0; i < out.length; i++) out[i] = buf.readInt8(Q8_HEADER + i) * scale;
    return out;
  }
  // float32 of earlier versions: a view when the bytes are 4-byte aligned, otherwise a copy. The
  // result shares memory with the blob – callers that keep it must copy.
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** Below this many vectors the exact scan is fast enough (and exact). */
export const PREFILTER_MIN = 20_000;

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export class VectorIndex {
  private dims = 0;
  private words = 0;
  private size = 0;
  private capacity = 0;
  private data = new Int8Array(0);
  private bits = new Uint32Array(0);
  private scales = new Float32Array(0);
  private ids = new Int32Array(0);
  private docs = new Int32Array(0);
  private readonly slotOf = new Map<number, number>();

  constructor(private readonly prefilterMin = PREFILTER_MIN) {}

  get count(): number {
    return this.size;
  }

  get dimensions(): number {
    return this.dims;
  }

  clear(): void {
    this.dims = 0;
    this.words = 0;
    this.size = 0;
    this.capacity = 0;
    this.data = new Int8Array(0);
    this.bits = new Uint32Array(0);
    this.scales = new Float32Array(0);
    this.ids = new Int32Array(0);
    this.docs = new Int32Array(0);
    this.slotOf.clear();
  }

  private grow(min: number): void {
    const cap = Math.max(min, Math.ceil(this.capacity * 1.5), 1024);
    const data = new Int8Array(cap * this.dims);
    data.set(this.data.subarray(0, this.size * this.dims));
    const bits = new Uint32Array(cap * this.words);
    bits.set(this.bits.subarray(0, this.size * this.words));
    const scales = new Float32Array(cap);
    scales.set(this.scales.subarray(0, this.size));
    const ids = new Int32Array(cap);
    ids.set(this.ids.subarray(0, this.size));
    const docs = new Int32Array(cap);
    docs.set(this.docs.subarray(0, this.size));
    Object.assign(this, { data, bits, scales, ids, docs, capacity: cap });
  }

  add(id: number, documentId: number, vector: Float32Array): void {
    if (!this.dims) {
      this.dims = vector.length;
      this.words = Math.ceil(vector.length / 32);
    }
    if (vector.length !== this.dims) throw new Error(`Vector has ${vector.length} dimensions, index expects ${this.dims}`);
    const v = normalize(vector);
    let slot = this.slotOf.get(id);
    if (slot === undefined) {
      if (this.size >= this.capacity) this.grow(this.size + 1);
      slot = this.size++;
      this.slotOf.set(id, slot);
    }
    let max = 0;
    for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
    const scale = max > 0 ? max / 127 : 1;
    const off = slot * this.dims;
    const boff = slot * this.words;
    this.bits.fill(0, boff, boff + this.words);
    for (let i = 0; i < v.length; i++) {
      this.data[off + i] = Math.round(v[i] / scale);
      if (v[i] > 0) this.bits[boff + (i >>> 5)] |= 1 << (i & 31);
    }
    this.scales[slot] = scale;
    this.ids[slot] = id;
    this.docs[slot] = documentId;
  }

  addMany(items: { id: number; documentId: number; vector: Float32Array }[]): void {
    if (items.length && this.size + items.length > this.capacity && this.dims) this.grow(this.size + items.length);
    for (const it of items) this.add(it.id, it.documentId, it.vector);
  }

  remove(id: number): void {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    const last = this.size - 1;
    if (slot !== last) {
      // Move the last vector into the freed slot.
      this.data.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
      this.bits.copyWithin(slot * this.words, last * this.words, (last + 1) * this.words);
      this.scales[slot] = this.scales[last];
      this.ids[slot] = this.ids[last];
      this.docs[slot] = this.docs[last];
      this.slotOf.set(this.ids[slot], slot);
    }
    this.slotOf.delete(id);
    this.size--;
  }

  removeDocument(documentId: number): void {
    const victims: number[] = [];
    for (let s = 0; s < this.size; s++) if (this.docs[s] === documentId) victims.push(this.ids[s]);
    for (const id of victims) this.remove(id);
  }

  has(id: number): boolean {
    return this.slotOf.has(id);
  }

  /**
   * Top-k most similar vectors (cosine similarity).
   * @param allowDocs optional set of document ids to restrict the search to (applied before ranking)
   */
  search(query: Float32Array, k: number, allowDocs?: Set<number> | null): VectorHit[] {
    if (!this.size || query.length !== this.dims || k <= 0) return [];
    const q = normalize(query);
    // Quantise the query as well to use integer arithmetic in the hot loop.
    let max = 0;
    for (let i = 0; i < q.length; i++) max = Math.max(max, Math.abs(q[i]));
    const qScale = max > 0 ? max / 127 : 1;
    const qi = new Int32Array(q.length);
    for (let i = 0; i < q.length; i++) qi[i] = Math.round(q[i] / qScale);

    const candidates = this.size > this.prefilterMin ? this.prefilter(q, Math.max(k * 20, 2000), allowDocs) : null;
    const dims = this.dims;
    const data = this.data;
    // Min-heap of the best k (score, slot) pairs.
    const heapScore = new Float64Array(k);
    const heapSlot = new Int32Array(k);
    let heapSize = 0;

    const siftDown = (i: number) => {
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && heapScore[l] < heapScore[m]) m = l;
        if (r < heapSize && heapScore[r] < heapScore[m]) m = r;
        if (m === i) return;
        [heapScore[i], heapScore[m]] = [heapScore[m], heapScore[i]];
        [heapSlot[i], heapSlot[m]] = [heapSlot[m], heapSlot[i]];
        i = m;
      }
    };
    const consider = (s: number) => {
      const off = s * dims;
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += data[off + i] * qi[i];
      const score = dot * this.scales[s] * qScale;
      if (heapSize < k) {
        // Sift up.
        let i = heapSize++;
        heapScore[i] = score;
        heapSlot[i] = s;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapScore[p] <= heapScore[i]) break;
          [heapScore[i], heapScore[p]] = [heapScore[p], heapScore[i]];
          [heapSlot[i], heapSlot[p]] = [heapSlot[p], heapSlot[i]];
          i = p;
        }
      } else if (score > heapScore[0]) {
        heapScore[0] = score;
        heapSlot[0] = s;
        siftDown(0);
      }
    };

    if (candidates) for (const s of candidates) consider(s);
    else
      for (let s = 0; s < this.size; s++) {
        if (allowDocs && !allowDocs.has(this.docs[s])) continue;
        consider(s);
      }

    const hits: VectorHit[] = [];
    for (let i = 0; i < heapSize; i++) {
      hits.push({ id: this.ids[heapSlot[i]], documentId: this.docs[heapSlot[i]], score: heapScore[i] });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  /** Slots of the `count` vectors with the smallest Hamming distance of the sign bits. */
  private prefilter(q: Float32Array, count: number, allowDocs?: Set<number> | null): Int32Array {
    const words = this.words;
    const qb = new Uint32Array(words);
    for (let i = 0; i < q.length; i++) if (q[i] > 0) qb[i >>> 5] |= 1 << (i & 31);
    const dist = new Uint16Array(this.size);
    const hist = new Uint32Array(this.dims + 1);
    const bits = this.bits;
    const skip = 0xffff;
    for (let s = 0; s < this.size; s++) {
      if (allowDocs && !allowDocs.has(this.docs[s])) {
        dist[s] = skip;
        continue;
      }
      const off = s * words;
      let d = 0;
      for (let w = 0; w < words; w++) d += popcount(bits[off + w] ^ qb[w]);
      dist[s] = d;
      hist[d]++;
    }
    // The distance up to which the best `count` vectors lie.
    let cut = 0;
    let acc = 0;
    while (cut < this.dims && acc + hist[cut] < count) acc += hist[cut++];
    const out: number[] = [];
    for (let s = 0; s < this.size; s++) if (dist[s] <= cut) out.push(s);
    return Int32Array.from(out);
  }

  /** Approximate memory footprint in bytes. */
  get memoryBytes(): number {
    return this.data.byteLength + this.bits.byteLength + this.scales.byteLength + this.ids.byteLength + this.docs.byteLength;
  }
}
