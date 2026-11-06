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
 * packages/ and examples/ (scripts, bun.lock, tsconfig, bunfig), and nothing when only Markdown changed. Data a
 * package's tests read from outside it maps to that package (`DATA_DIRS`); the rest of docs/ is skipped. It defers
 * the end-to-end files in `DEFERRED` when their package is only a dependent of what changed, and prints them with the
 * command that runs them (D161), and sets `FAST_ENV` (kg.test.ts's differential test at 25 seeds, D176). It is a fast loop, not a gate: `bun run check` runs every test before a merge, and
 * `test:pkg` runs every file of the packages it names. Arguments after `--` go to `bun test`;
 * `--dry` prints the directories it would test and runs nothing; `--base REF` diffs against REF instead (`--base
 * HEAD`: only what is not committed yet). EDEN_TEST_SELECT_ROOT names another repository to select in (its test).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.EDEN_TEST_SELECT_ROOT || join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const head = dash >= 0 ? argv.slice(0, dash) : argv;
const dry = head.includes("--dry");
const baseAt = head.indexOf("--base");
const baseRef = baseAt >= 0 ? head[baseAt + 1] : undefined;
const [mode, ...names] = head.filter((a, i) => a !== "--dry" && (baseAt < 0 || (i !== baseAt && i !== baseAt + 1)));
const extra = dash >= 0 ? argv.slice(dash + 1) : [];

/**
 * Directories outside the packages whose files a package's tests read, with that package. Checked before the docs/
 * skip: packages/server/src/engine-config.test.ts parses every docs/profiles/*.json (D104), so a typo in a profile
 * would otherwise pass test:changed and check:fast.
 */
export const DATA_DIRS: Record<string, string> = { "docs/profiles/": "packages/server" };

/**
 * End-to-end files that `test:changed` skips when their package is selected only as a dependent of a changed package
 * (D161): together 9 of the 18 s an engine edit took when D161 measured it. They run when their own package changed,
 * in `test:pkg`, and in `bun run check`. A list, not a `.e2e.test.ts` suffix, because docs and package CLAUDE.md files
 * name these files. Since D169 the engine's own kg.test.ts holds a 200-seed differential test (about 4.7-5 s of a
 * 6 s file); `test:changed` runs it at 25 seeds through `FAST_ENV` (D176) rather than deferring it.
 */
export const DEFERRED = [
  "packages/sim/src/sim.test.ts",
  "packages/sim/src/lab/funnel-flags.test.ts",
  "packages/sim/src/lab/reader-stub.test.ts",
  "packages/sim/src/deletes.test.ts",
  "packages/sim/src/lab/gate-traffic.test.ts",
  "packages/eval/src/run.test.ts",
];

/**
 * Variables `test:changed` (and so `check:fast`) sets for its run and `test:pkg` does not, so `bun run check` and
 * `test:pkg` keep the full counts. KG_DIFF_SEEDS: kg.test.ts's differential test against the storage before D169 runs
 * 25 seeds instead of 200 (D176). No EDEN_ prefix: scripts/test-preload.ts clears those before a test loads.
 */
export const FAST_ENV: Record<string, string> = { KG_DIFF_SEEDS: "25" };

/** The environment `bun test` runs under for `mode`: `FAST_ENV` added for `changed`, where the caller set none. */
export function testEnv(mode: string | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (mode !== "changed") return env;
  const out = { ...env };
  for (const [k, v] of Object.entries(FAST_ENV)) if (out[k] === undefined) out[k] = v;
  return out;
}

export interface Pkg {
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

/** The packages to test and the ones a file changed in, or null for everything. */
function changedDirs(pkgs: Pkg[]): Selection | null {
  const base = git("merge-base", "HEAD", baseRef ?? "origin/main")?.trim();
  if (!base) {
    console.error(`test:changed: no merge base with ${baseRef ?? "origin/main"} (git fetch?); running every test`);
    return null;
  }
  const files = new Set<string>();
  for (const out of [git("diff", "--name-only", base), git("ls-files", "--others", "--exclude-standard")]) {
    for (const f of (out ?? "").split("\n")) if (f) files.add(f);
  }
  return selectPackages([...files], pkgs);
}

/** Package directories in workspace order: `dirs` to test, and the subset `direct` that a changed file is in. */
export interface Selection {
  dirs: string[];
  direct: string[];
}

/**
 * The directories of the packages `files` touch plus their dependents, in workspace order; null (test everything)
 * when a file is outside the packages, the data directories and the skipped docs.
 */
export function touchedPackages(files: string[], pkgs: Pkg[], log = console.error): string[] | null {
  return selectPackages(files, pkgs, log)?.dirs ?? null;
}

/** `touchedPackages`, also saying which packages changed themselves rather than only depend on a change. */
export function selectPackages(files: string[], pkgs: Pkg[], log = console.error): Selection | null {
  const touched = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".md")) continue;
    const data = Object.entries(DATA_DIRS).find(([prefix]) => f.startsWith(prefix))?.[1];
    if (data === undefined && (f.startsWith("docs/") || f.startsWith("archived/") || f.startsWith("bench/"))) continue;
    const pkg = pkgs.find((p) => (data === undefined ? f.startsWith(`${p.dir}/`) : p.dir === data));
    if (!pkg) {
      log(`test:changed: ${f} is outside the packages; running every test`);
      return null;
    }
    touched.add(pkg.name);
  }
  const direct = pkgs.filter((p) => touched.has(p.name)).map((p) => p.dir);
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
  return { dirs: pkgs.filter((p) => touched.has(p.name)).map((p) => p.dir), direct };
}

/** The `DEFERRED` files whose package is in `sel.dirs` only as a dependent, in `DEFERRED` order (D161). */
export function deferredFiles(sel: Selection): string[] {
  const owner = (f: string) => sel.dirs.find((d) => f.startsWith(`${d}/`));
  return DEFERRED.filter((f) => {
    const dir = owner(f);
    return dir !== undefined && !sel.direct.includes(dir);
  });
}

if (import.meta.main) main();

function main(): void {
  const pkgs = workspace();
  let dirs: string[] | null;
  let deferred: string[] = [];
  if (mode === "changed") {
    const sel = changedDirs(pkgs);
    dirs = sel?.dirs ?? null;
    // Only files that exist: a stale entry must not make `bun test` ignore a pattern that matches nothing new.
    if (sel) deferred = deferredFiles(sel).filter((f) => existsSync(join(root, f)));
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
  // A Bun without --path-ignore-patterns cannot skip single files: run them rather than fail.
  if (deferred.length && !dry && !bunCanIgnorePaths()) {
    console.log("test:changed: this bun test has no --path-ignore-patterns; running the end-to-end files too");
    deferred = [];
  }
  // Packages with no test file of their own (protocol's types-only edits still reach their dependents' tests), or
  // whose only test files are deferred.
  const withTests = dirs?.filter((d) => {
    const r = spawnSync("find", [d, "-name", "*.test.ts", "-not", "-path", "*/node_modules/*"], {
      cwd: root,
      encoding: "utf8",
    });
    return r.stdout.split("\n").some((f) => f && !deferred.includes(f));
  });
  if (deferred.length) {
    console.log(
      `test:changed: deferred ${deferred.length} end-to-end file(s) of packages that only depend on what changed ` +
        "(`bun run check` runs them; D161):",
    );
    for (const f of deferred) console.log(`  ${f}`);
    console.log(`  run them: bun test ${deferred.map((f) => `./${f}`).join(" ")}`);
  }
  if (withTests && withTests.length === 0) {
    console.log(`no test files to run under ${dirs!.join(", ")}`);
    process.exit(0);
  }
  if (withTests) console.log(`testing ${withTests.join(" ")}`);
  const env = testEnv(mode, process.env);
  const fast = Object.keys(FAST_ENV).map((k) => `${k}=${env[k]}`);
  if (mode === "changed") console.log(`test:changed: ${fast.join(" ")} (\`bun run check\` runs the full counts; D176)`);
  if (dry) {
    if (!withTests) console.log("testing everything");
    process.exit(0);
  }
  const ignore = deferred.map((f) => `--path-ignore-patterns=${f}`);
  const args = [...(withTests ?? []), ...ignore, ...extra];
  const r = spawnSync(join(root, "scripts/test.sh"), args, { cwd: root, stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

function bunCanIgnorePaths(): boolean {
  const r = spawnSync("bun", ["test", "--help"], { cwd: root, encoding: "utf8" });
  return `${r.stdout}${r.stderr}`.includes("--path-ignore-patterns");
}
