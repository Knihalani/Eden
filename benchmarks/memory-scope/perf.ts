import { derive, listFiles } from "./scope";
import { VARIANTS } from "./run";
import { readdirSync, existsSync } from "fs";
const REC = VARIANTS.find(v => v.name.startsWith("REC ("))!;
function walk(root: string, skipNM: boolean) { let n = 0; const st = [""]; while (st.length) { const d = st.pop()!; let es; try { es = readdirSync(root + "/" + d, { withFileTypes: true }); } catch { continue; } for (const e of es) { if (e.name === ".git") continue; if (skipNM && e.name === "node_modules") continue; const p = d ? d + "/" + e.name : e.name; if (e.isDirectory()) st.push(p); else n++; } } return n; }
const t = async (f: () => any) => { const a = performance.now(); const r = await f(); return [+(performance.now() - a).toFixed(0), r]; };
for (const root of process.argv.slice(2)) {
  const [lsMs, files] = await t(() => listFiles(root));
  const [lsTracked] = await t(() => Bun.$`git -C ${root} ls-files -z`.quiet().text());
  const [walkAllMs, walkAll] = await t(() => walk(root, false));
  const [walkNMMs, walkNM] = await t(() => walk(root, true));
  const [dMs, r] = await t(() => derive(root, files, REC));
  const sample = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 1000)) === 0);
  const [lookMs] = await t(() => { for (let k = 0; k < 100; k++) for (const f of sample) r.nearest(f.slice(0, f.lastIndexOf("/") > 0 ? f.lastIndexOf("/") : 0)); });
  const M = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  const [statMs] = await t(() => { for (const f of sample) { let d = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""; while (true) { if (M.some(m => existsSync(root + "/" + (d ? d + "/" : "") + m))) break; if (!d) break; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : ""; } } });
  const json = JSON.stringify(Object.fromEntries([...r.scopes].map(s => [s, 1])));
  console.log(JSON.stringify({ repo: root.split("/").pop(), files: files.length, lsCoMs: lsMs, lsTrackedMs: lsTracked, walkAllFiles: walkAll, walkAllMs, walkNoNmFiles: walkNM, walkNoNmMs: walkNMMs, deriveMs: dMs, scopes: r.scopes.size, scopesJsonBytes: json.length, cachedLookupUs: +(1000 * lookMs / (100 * sample.length)).toFixed(2), uncachedStatWalkUs: +(1000 * statMs / sample.length).toFixed(0) }));
}
process.exit(0);
