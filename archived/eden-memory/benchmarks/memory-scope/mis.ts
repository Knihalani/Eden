import { derive, listFiles } from "./scope";
import { VARIANTS, TRUTH, truthOf } from "./run";
const [n, vi] = process.argv.slice(2);
const root = n === "Eden" ? "/Users/kaiavnihalani/Downloads/Eden" : import.meta.dir + "/repos/" + n;
const files = await listFiles(root);
const r = derive(root, files, VARIANTS[+vi]);
const t = truthOf(TRUTH[n]);
const m = new Map<string, number>();
for (const f of files) {
  const d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
  const s = r.nearest(d),
    p = t(d);
  if (s !== p) {
    const k = `truth=${p || '""'}  derived=${s || '""'}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
}
for (const [k, c] of [...m].sort((a, b) => b[1] - a[1]).slice(0, +(process.env.N ?? 15)))
  console.log(String(c).padStart(6), k);
if (import.meta.main) process.exit(0);
