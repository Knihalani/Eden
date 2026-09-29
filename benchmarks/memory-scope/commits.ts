import { derive, listFiles } from "./scope";
import { VARIANTS } from "./run";
const root = "/Users/kaiavnihalani/Downloads/Eden";
const files = await listFiles(root);
for (const v of [VARIANTS[0], VARIANTS.find(v => v.name.startsWith("REC ("))!]) {
  const r = derive(root, files, v);
  const log = await Bun.$`git -C ${root} log -400 --name-only --format=@@%h`.quiet().text();
  const commits = log.split("@@").slice(1).map(c => c.split("\n").slice(1).filter(Boolean));
  let multi = 0, n = 0, withRoot = 0, pairs = new Map<string, number>(), sc2multi = 0;
  const hist = new Map<number, number>();
  for (const fs of commits) {
    if (!fs.length) continue; n++;
    const ss = new Set(fs.map(f => r.nearest(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")));
    const s2 = new Set(fs.map(f => f.split("/").slice(0, Math.min(2, f.split("/").length - 1)).join("/")));
    if (s2.size > 1) sc2multi++;
    hist.set(Math.min(ss.size, 5), (hist.get(Math.min(ss.size, 5)) ?? 0) + 1);
    if (ss.size > 1) { multi++; if (ss.has("")) withRoot++; for (const s of ss) pairs.set(s || '""', (pairs.get(s || '""') ?? 0) + 1); }
  }
  console.log(v.name, { commits: n, multiScope: multi, pct: +(100 * multi / n).toFixed(0), multiIncludingRoot: withRoot, scope2Multi: sc2multi, hist: Object.fromEntries(hist), topInMulti: [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 8) });
}
process.exit(0);
