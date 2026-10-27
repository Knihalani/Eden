import { loadM2V } from "./m2v";
const ref = await Bun.file("m2v_ref.json").json();
const dirs: Record<string, string> = { base8m: "m2v/potion-base-8M", ret32m: "m2v/potion-retrieval-32M" };
for (const k of Object.keys(dirs)) {
  const m = loadM2V(dirs[k]!);
  let minCos = 1,
    idMis = 0,
    n = 0;
  ref.texts.forEach((t: string, i: number) => {
    const ids = m.tokenize(t).filter((x) => x !== m.unk),
      r = ref[k].ids[i] as number[];
    if (JSON.stringify(ids) !== JSON.stringify(r)) {
      idMis++;
      if (idMis < 4) console.log("ID MISMATCH", JSON.stringify(t), ids.slice(0, 20), r.slice(0, 20));
    }
    const v = m.embed(t),
      w = ref[k].emb[i] as number[];
    let c = 0,
      nv = 0,
      nw = 0;
    for (let j = 0; j < v.length; j++) {
      c += v[j]! * w[j]!;
      nv += v[j]! ** 2;
      nw += w[j]! ** 2;
    }
    if (nv === 0 && nw === 0) return;
    const cos = c / Math.sqrt(nv * nw);
    n++;
    if (cos < minCos) minCos = cos;
  });
  console.log(
    k,
    "texts",
    ref.texts.length,
    "token-id mismatches",
    idMis,
    "min cosine",
    minCos.toFixed(7),
    "compared",
    n,
  );
}
