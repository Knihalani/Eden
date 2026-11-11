// One BERT layer (bge-small shape: d 384, 12 heads, FFN 1536) at T tokens, plain TypeScript loops: fp32 weights and
// int8 weights with per-row scales. Times a layer; a full encoder is 12 layers.
const d = 384,
  ffn = 1536,
  H = 12,
  T = Number(process.argv[2] ?? 128);
const rnd = (n: number) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() - 0.5;
  return a;
};
const q8 = (w: Float32Array, rows: number, cols: number) => {
  const q = new Int8Array(rows * cols),
    s = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let m = 0;
    for (let c = 0; c < cols; c++) m = Math.max(m, Math.abs(w[r * cols + c]!));
    s[r] = m / 127 || 1;
    for (let c = 0; c < cols; c++) q[r * cols + c] = Math.round(w[r * cols + c]! / s[r]!);
  }
  return { q, s };
};
// y[t, r] = sum_c x[t, c] * W[r, c]  (W rows = outputs)
function mm32(x: Float32Array, W: Float32Array, rows: number, cols: number, y: Float32Array) {
  for (let t = 0; t < T; t++) {
    const xo = t * cols;
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      const wo = r * cols;
      for (let c = 0; c < cols; c++) acc += x[xo + c]! * W[wo + c]!;
      y[t * rows + r] = acc;
    }
  }
}
function mm8(x: Float32Array, W: { q: Int8Array; s: Float32Array }, rows: number, cols: number, y: Float32Array) {
  for (let t = 0; t < T; t++) {
    const xo = t * cols;
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      const wo = r * cols;
      for (let c = 0; c < cols; c++) acc += x[xo + c]! * W.q[wo + c]!;
      y[t * rows + r] = acc * W.s[r]!;
    }
  }
}
function layer(
  mm: (x: Float32Array, W: any, r: number, c: number, y: Float32Array) => void,
  Ws: any[],
  x: Float32Array,
) {
  const q = new Float32Array(T * d),
    k = new Float32Array(T * d),
    v = new Float32Array(T * d),
    o = new Float32Array(T * d);
  mm(x, Ws[0], d, d, q);
  mm(x, Ws[1], d, d, k);
  mm(x, Ws[2], d, d, v);
  const hd = d / H,
    att = new Float32Array(T),
    ctx = new Float32Array(T * d);
  for (let h = 0; h < H; h++)
    for (let i = 0; i < T; i++) {
      let mx = -1e9;
      for (let j = 0; j < T; j++) {
        let s = 0;
        for (let e = 0; e < hd; e++) s += q[i * d + h * hd + e]! * k[j * d + h * hd + e]!;
        att[j] = s;
        if (s > mx) mx = s;
      }
      let z = 0;
      for (let j = 0; j < T; j++) {
        att[j] = Math.exp(att[j]! - mx);
        z += att[j]!;
      }
      for (let e = 0; e < hd; e++) {
        let s = 0;
        for (let j = 0; j < T; j++) s += att[j]! * v[j * d + h * hd + e]!;
        ctx[i * d + h * hd + e] = s / z;
      }
    }
  mm(ctx, Ws[3], d, d, o);
  const f1 = new Float32Array(T * ffn),
    f2 = new Float32Array(T * d);
  mm(o, Ws[4], ffn, d, f1);
  for (let i = 0; i < f1.length; i++) f1[i] = f1[i]! / (1 + Math.exp(-1.702 * f1[i]!));
  mm(f1, Ws[5], d, ffn, f2);
  return f2;
}
const shapes: [number, number][] = [
  [d, d],
  [d, d],
  [d, d],
  [d, d],
  [ffn, d],
  [d, ffn],
];
const W32 = shapes.map(([r, c]) => rnd(r * c));
const W8 = shapes.map(([r, c], i) => q8(W32[i]!, r, c));
const x = rnd(T * d);
for (const [name, mm, Ws] of [
  ["fp32", mm32, W32],
  ["int8w", mm8, W8],
] as const) {
  layer(mm as any, Ws as any, x);
  const t0 = performance.now();
  const n = 5;
  for (let i = 0; i < n; i++) layer(mm as any, Ws as any, x);
  const ms = (performance.now() - t0) / n;
  console.log(`${name} T=${T}: one layer ${ms.toFixed(1)} ms, 12 layers ~${(12 * ms).toFixed(0)} ms an item`);
}
