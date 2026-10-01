/**
 * Compact in-memory vector index.
 *
 * Vectors are L2-normalised and stored as int8 with a per-vector scale
 * (4× smaller than float32). Search is an exact brute-force scan, which for
 * the size of a personal archive (≤ a few hundred thousand passages) takes
 * only milliseconds and needs no extra native dependency.
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

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer | Uint8Array): Float32Array {
  // Copy to guarantee 4-byte alignment.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export class VectorIndex {
  private dims = 0;
  private size = 0;
  private capacity = 0;
  private data = new Int8Array(0);
  private scales = new Float32Array(0);
  private ids = new Int32Array(0);
  private docs = new Int32Array(0);
  private readonly slotOf = new Map<number, number>();

  get count(): number {
    return this.size;
  }

  get dimensions(): number {
    return this.dims;
  }

  clear(): void {
    this.dims = 0;
    this.size = 0;
    this.capacity = 0;
    this.data = new Int8Array(0);
    this.scales = new Float32Array(0);
    this.ids = new Int32Array(0);
    this.docs = new Int32Array(0);
    this.slotOf.clear();
  }

  private grow(min: number): void {
    const cap = Math.max(min, Math.ceil(this.capacity * 1.5), 1024);
    const data = new Int8Array(cap * this.dims);
    data.set(this.data.subarray(0, this.size * this.dims));
    const scales = new Float32Array(cap);
    scales.set(this.scales.subarray(0, this.size));
    const ids = new Int32Array(cap);
    ids.set(this.ids.subarray(0, this.size));
    const docs = new Int32Array(cap);
    docs.set(this.docs.subarray(0, this.size));
    Object.assign(this, { data, scales, ids, docs, capacity: cap });
  }

  add(id: number, documentId: number, vector: Float32Array): void {
    if (!this.dims) this.dims = vector.length;
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
    for (let i = 0; i < v.length; i++) this.data[off + i] = Math.round(v[i] / scale);
    this.scales[slot] = scale;
    this.ids[slot] = id;
    this.docs[slot] = documentId;
  }

  remove(id: number): void {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return;
    const last = this.size - 1;
    if (slot !== last) {
      // Move the last vector into the freed slot.
      this.data.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
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
   * @param allowDocs optional set of document ids to restrict the search to
   */
  search(query: Float32Array, k: number, allowDocs?: Set<number> | null): VectorHit[] {
    if (!this.size || query.length !== this.dims) return [];
    const q = normalize(query);
    // Quantise the query as well to use integer arithmetic in the hot loop.
    let max = 0;
    for (let i = 0; i < q.length; i++) max = Math.max(max, Math.abs(q[i]));
    const qScale = max > 0 ? max / 127 : 1;
    const qi = new Int32Array(q.length);
    for (let i = 0; i < q.length; i++) qi[i] = Math.round(q[i] / qScale);

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

    for (let s = 0; s < this.size; s++) {
      if (allowDocs && !allowDocs.has(this.docs[s])) continue;
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
    }

    const hits: VectorHit[] = [];
    for (let i = 0; i < heapSize; i++) {
      hits.push({ id: this.ids[heapSlot[i]], documentId: this.docs[heapSlot[i]], score: heapScore[i] });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  /** Approximate memory footprint in bytes. */
  get memoryBytes(): number {
    return this.data.byteLength + this.scales.byteLength + this.ids.byteLength + this.docs.byteLength;
  }
}
