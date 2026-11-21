// Brute-force vector search like src/server/rag/vectorIndex.ts (int8 + scale), plus a 1-bit variant.
// Usage: node bench-vectors.mjs [passages=1000000] [dims=768]   (1M x 1536 needs --max-old-space-size=4096)
const N = Number(process.argv[2] ?? 1_000_000);
const DIMS = Number(process.argv[3] ?? 768);
const K = 50;

function rnd() {
  return Math.random() * 2 - 1;
}

const data = new Int8Array(N * DIMS);
const scales = new Float32Array(N);
for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 255 - 127) | 0;
for (let i = 0; i < N; i++) scales[i] = 0.01;

const qi = new Int32Array(DIMS);
for (let i = 0; i < DIMS; i++) qi[i] = Math.round(rnd() * 127);

function searchInt8() {
  const heapScore = new Float64Array(K);
  const heapSlot = new Int32Array(K);
  let heapSize = 0;
  const siftDown = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heapSize && heapScore[l] < heapScore[m]) m = l;
      if (r < heapSize && heapScore[r] < heapScore[m]) m = r;
      if (m === i) return;
      [heapScore[i], heapScore[m]] = [heapScore[m], heapScore[i]];
      [heapSlot[i], heapSlot[m]] = [heapSlot[m], heapSlot[i]];
      i = m;
    }
  };
  for (let s = 0; s < N; s++) {
    const off = s * DIMS;
    let dot = 0;
    for (let i = 0; i < DIMS; i++) dot += data[off + i] * qi[i];
    const score = dot * scales[s];
    if (heapSize < K) {
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
  return heapSize;
}

// 1 bit per dimension (sign), Hamming distance via popcount.
const WORDS = DIMS / 32;
const bits = new Uint32Array(N * WORDS);
for (let i = 0; i < bits.length; i++) bits[i] = (Math.random() * 0x100000000) >>> 0;
const qb = new Uint32Array(WORDS);
for (let i = 0; i < WORDS; i++) qb[i] = (Math.random() * 0x100000000) >>> 0;

function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function searchBinary(cand = 1000) {
  // Keep the `cand` smallest distances (histogram, distances are 0..DIMS).
  const dist = new Uint16Array(N);
  const hist = new Uint32Array(DIMS + 1);
  for (let s = 0; s < N; s++) {
    const off = s * WORDS;
    let d = 0;
    for (let w = 0; w < WORDS; w++) d += popcnt(bits[off + w] ^ qb[w]);
    dist[s] = d;
    hist[d]++;
  }
  let cut = 0, acc = 0;
  while (cut <= DIMS && acc + hist[cut] < cand) acc += hist[cut++];
  let n = 0;
  for (let s = 0; s < N; s++) if (dist[s] <= cut) n++;
  return n;
}

function time(label, fn, runs = 5) {
  fn();
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  console.log(`${label}: median ${t[Math.floor(runs / 2)].toFixed(0)} ms`);
}

console.log(`N=${N.toLocaleString('en')} dims=${DIMS}  int8 RAM=${((N * DIMS) / 2 ** 20).toFixed(0)} MiB  binary RAM=${((N * DIMS) / 8 / 2 ** 20).toFixed(0)} MiB`);
time('int8 brute force (as today)', searchInt8);
time('1-bit Hamming prefilter (top 1000)', () => searchBinary());
