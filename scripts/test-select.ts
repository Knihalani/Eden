#!/usr/bin/env bun
/**
 * Runs the tests of some workspace packages through scripts/test.sh (same preload, temp HOME and parallelism).
 *
 *   bun run test:pkg engine sim     the named packages (`packages/<name>`, `examples/<name>` or a path)
 *   bun run test:changed            the packages touched since the merge base with origin/main, committed or not,
 *                                   plus every package that depends on one of them (a change to @eden/engine also
 *                                   runs sim, server and eval)
 *
 * `test:changed` runs everything when it cannot tell what changed (no origin/main) or when a change is outside
 * packages/ and examples/ (scripts, bun.lock, tsconfig, bunfig), and nothing when only Markdown changed. It is a
 * fast loop, not a gate: `bun run check` runs every test before a merge. Arguments after `--` go to `bun test`;
 * `--dry` prints the directories it would test and runs nothing; `--base REF` diffs against REF instead (`--base
 * HEAD`: only what is not committed yet).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const head = dash >= 0 ? argv.slice(0, dash) : argv;
const dry = head.includes("--dry");
const baseAt = head.indexOf("--base");
const baseRef = baseAt >= 0 ? head[baseAt + 1] : undefined;
const [mode, ...names] = head.filter((a, i) => a !== "--dry" && (baseAt < 0 || (i !== baseAt && i !== baseAt + 1)));
const extra = dash >= 0 ? argv.slice(dash + 1) : [];

interface Pkg {
  dir: string;
  name: string;
  deps: string[];
}

/** Every workspace package with its @eden/* dependencies (dev ones too: sim's tests import pi-ai through them). */
function workspace(): Pkg[] {
  const out: Pkg[] = [];
  for (const parent of ["packages", "examples"]) {
    if (!existsSync(join(root, parent))) continue;
    for (const d of readdirSync(join(root, parent))) {
      const file = join(root, parent, d, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | string>;
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
      out.push({ dir: `${parent}/${d}`, name: String(pkg.name), deps: Object.keys(deps) });
    }
  }
  return out;
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
};

/** The workspace directories to test, or null for everything. */
function changedDirs(pkgs: Pkg[]): string[] | null {
  const base = git("merge-base", "HEAD", baseRef ?? "origin/main")?.trim();
  if (!base) {
    console.error(`test:changed: no merge base with ${baseRef ?? "origin/main"} (git fetch?); running every test`);
    return null;
  }
  const files = new Set<string>();
  for (const out of [git("diff", "--name-only", base), git("ls-files", "--others", "--exclude-standard")]) {
    for (const f of (out ?? "").split("\n")) if (f) files.add(f);
  }
  const touched = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".md") || f.startsWith("docs/") || f.startsWith("archived/") || f.startsWith("bench/")) continue;
    const pkg = pkgs.find((p) => f.startsWith(`${p.dir}/`));
    if (!pkg) {
      console.error(`test:changed: ${f} is outside the packages; running every test`);
      return null;
    }
    touched.add(pkg.name);
  }
  // Dependents, to a fixed point: a change to a package can break any package that imports it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pkgs) {
      if (!touched.has(p.name) && p.deps.some((d) => touched.has(d))) {
        touched.add(p.name);
        grew = true;
      }
    }
  }
  return pkgs.filter((p) => touched.has(p.name)).map((p) => p.dir);
}

const pkgs = workspace();
let dirs: string[] | null;
if (mode === "changed") {
  dirs = changedDirs(pkgs);
} else if (mode === "pkg" && names.length) {
  dirs = names.map((n) => {
    const hit = pkgs.find((p) => p.dir === n.replace(/\/$/, "") || p.dir.endsWith(`/${n}`) || p.name === n);
    if (hit) return hit.dir;
    if (existsSync(join(root, n))) return n;
    console.error(`test:pkg: no package "${n}" (known: ${pkgs.map((p) => p.dir.split("/")[1]).join(", ")})`);
    process.exit(2);
  });
} else {
  console.error("usage: bun scripts/test-select.ts changed | pkg <name> [...] [-- bun test args]");
  process.exit(2);
}

if (dirs && dirs.length === 0) {
  console.log(`test:changed: no package code changed since ${baseRef ?? "origin/main"}; nothing to test`);
  process.exit(0);
}
// Packages with no test file of their own (protocol's types-only edits still reach their dependents' tests).
const withTests = dirs?.filter((d) => {
  const r = spawnSync("find", [d, "-name", "*.test.ts", "-not", "-path", "*/node_modules/*"], {
    cwd: root,
    encoding: "utf8",
  });
  return r.stdout.trim().length > 0;
});
if (withTests && withTests.length === 0) {
  console.log(`no test files under ${dirs!.join(", ")}`);
  process.exit(0);
}
if (withTests) console.log(`testing ${withTests.join(" ")}`);
if (dry) {
  if (!withTests) console.log("testing everything");
  process.exit(0);
}
const r = spawnSync(join(root, "scripts/test.sh"), [...(withTests ?? []), ...extra], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
