import { derive, listFiles } from "./scope";
import { VARIANTS } from "./run";
import { existsSync, readFileSync } from "fs";
const EDEN = "/Users/kaiavnihalani/Downloads/Eden";
const ev: [string, string, number, string | null, boolean][] = JSON.parse(readFileSync("eden_events.json", "utf8"));
const files = await listFiles(EDEN);
const rec = derive(
  EDEN,
  files,
  VARIANTS.find((v) => v.name.startsWith("REC ("))!,
);
const v0 = derive(EDEN, files, VARIANTS[0]);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const naive = (abs: string) => {
  // on-disk walk, relative to Eden root, named manifest
  let d = dirOf(abs);
  while (d.startsWith(EDEN)) {
    for (const m of ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"])
      if (existsSync(d + "/" + m)) return d.slice(EDEN.length + 1);
    d = dirOf(d);
  }
  return "";
};
const norm = (abs: string) => {
  const m = abs.match(/^(.*?\/Downloads\/Eden)\/\.claude\/worktrees\/[^/]+\/(.*)$/);
  if (m) return m[2];
  if (abs.startsWith(EDEN + "/")) return abs.slice(EDEN.length + 1);
  return null;
};
const schemes: Record<string, (p: string) => string | null> = {
  "naive fs walk (worktree prefix kept)": (p) => (p.startsWith(EDEN + "/") ? naive(p) : null),
  "v0 rule, worktree-normalized": (p) => {
    const r = norm(p);
    return r === null ? null : v0.nearest(dirOf(r));
  },
  "REC rule, worktree-normalized": (p) => {
    const r = norm(p);
    return r === null ? null : rec.nearest(dirOf(r));
  },
  "scope2, worktree-normalized": (p) => {
    const r = norm(p);
    if (r === null) return null;
    const s = r.split("/");
    return s.slice(0, Math.min(2, s.length - 1)).join("/");
  },
};
const sessions = new Map<string, typeof ev>();
for (const e of ev) {
  if (!sessions.has(e[0])) sessions.set(e[0], []);
  sessions.get(e[0])!.push(e);
}
for (const [name, f] of Object.entries(schemes)) {
  let pred = 0,
    tot = 0,
    multi = 0,
    turnsWith = 0;
  const distinct = new Set<string>();
  for (const [, es] of sessions) {
    es.sort((a, b) => (a[1] < b[1] ? -1 : 1));
    const turns: string[][] = [];
    let cur: string[] | null = null;
    for (const e of es) {
      if (e[2]) {
        cur = [];
        turns.push(cur);
      } else if (cur && e[3]) {
        const s = f(e[3]);
        if (s !== null) {
          cur.push(s);
          distinct.add(s);
        }
      }
    }
    const maj = (xs: string[]) => {
      const c = new Map<string, number>();
      for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
      return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    for (let i = 0; i < turns.length; i++) {
      if (!turns[i].length) continue;
      turnsWith++;
      if (new Set(turns[i]).size > 1) multi++;
      const prev = turns.slice(Math.max(0, i - 3), i).flat();
      if (!prev.length) continue;
      tot++;
      if (maj(prev) === maj(turns[i])) pred++;
    }
  }
  console.log(
    `${name.padEnd(40)} turns=${turnsWith} multiScopeTurns=${multi} predict=${pred}/${tot} ` +
      `distinctScopes=${distinct.size}`,
  );
}
process.exit(0);
