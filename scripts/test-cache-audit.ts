#!/usr/bin/env bun
/**
 * Checks the test cache's keys (scripts/test-cache.ts, D650) against what each test really reads: runs every test file
 * alone under `strace`, collects the repository files the process and its children opened, and reports any file that
 * the test's key does not cover. A reported file means an edit to it would not re-run that test: fix the sign that
 * missed it (`TREE_SIGNS`, `REPO_PATH`, `DOCS_PATH`), or the test.
 *
 *   bun scripts/test-cache-audit.ts [test files...] [--jobs 4] [--reads out.json] [--write]
 *
 * It traces opens, stats, access checks and link reads, of files and of directories (a listing is an input too).
 * `--write` (with no files named: the whole suite) records in scripts/test-cache-verified.txt the tests with no sign
 * that read nothing outside their closure, bound to their closure's bytes: test-cache.ts keys every other test on the
 * whole tree (D658).
 *
 * Linux with strace only; a few minutes for the whole suite. Not part of `bun run check`: run it after changing
 * scripts/test-cache.ts, and when a test starts reading files in a new way.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { closure, closureHash, configFiles, isProse, joinTrace, treeFiles, VERIFIED } from "./test-cache";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const argv = process.argv.slice(2);
const jobsAt = argv.indexOf("--jobs");
const jobs = jobsAt >= 0 ? Number(argv[jobsAt + 1]) : 4;
const readsAt = argv.indexOf("--reads");
const readsFile = readsAt >= 0 ? argv[readsAt + 1] : undefined;
const valueAt = new Set([jobsAt, readsAt].filter((i) => i >= 0).map((i) => i + 1));
const named = argv.filter((a, i) => !a.startsWith("--") && !valueAt.has(i));
const tests =
  named.length > 0
    ? named.map((t) => t.replace(/^\.\//, ""))
    : (treeFiles() ?? []).filter((p) => /\.test\.tsx?$/.test(p) && /^(packages|examples|scripts)\//.test(p));
if (spawnSync("strace", ["-V"]).status !== 0) {
  console.error("test-cache-audit: strace is not installed");
  process.exit(2);
}

const tree = new Set(treeFiles() ?? []);
/** Every directory that holds a tracked file. */
const dirs = new Set<string>();
for (const f of tree) for (let d = dirname(f); d !== "." && !dirs.has(d); d = dirname(d)) dirs.add(d);
const config = new Set(configFiles());
const tmp = mkdtempSync(join(tmpdir(), "eden-cache-audit-"));

interface Finding {
  test: string;
  missed: string[];
  failed: boolean;
  /** Every tracked file the run opened (`--reads FILE` writes them, for narrowing a sign on evidence). */
  reads: string[];
  /** For a test whose closure reads files and is not keyed on the tree: its line for `VERIFIED`. */
  bound: string | null;
}

function audit(test: string, slot: number): Promise<Finding> {
  const out = join(tmp, `trace-${slot}`);
  const calls = "trace=open,openat,openat2,stat,lstat,newfstatat,statx,access,faccessat,faccessat2,readlink,readlinkat";
  const args = ["-f", "-qq", "-e", calls, "-o", out, "bun", "test", `./${test}`];
  return new Promise((done) => {
    const child = spawn("strace", args, { cwd: ROOT, stdio: "ignore" });
    child.on("close", (code) => {
      const c = closure(realpathSync(resolve(ROOT, test)));
      const covered = new Set(c.files.map((f) => relative(ROOT, f)));
      const missed = new Set<string>();
      const reads = new Set<string>();
      // Directories that hold a file of the key: Bun's resolver lists and stats them for every import.
      const ancestors = new Set<string>([""]);
      for (const f of [...covered, ...config]) {
        for (let d = dirname(f); d !== "." && !ancestors.has(d); d = dirname(d)) ancestors.add(d);
      }
      for (const line of joinTrace(readFileSync(out, "utf8"))) {
        // A successful read of a path: an open that is not a write, or a stat, an access check, a link read. A failed
        // one is not traced: a file that does not exist yet can only matter through a listing or the tree.
        const m = /^\d+\s+(\w+)\((?:AT_FDCWD, )?"([^"]+)"(?:, ([A-Z_|0-9]+))?[^)]*\)\s+= (\d+)/.exec(line);
        if (!m) continue;
        const opened = m[1]!.startsWith("open");
        if (opened && /O_WRONLY|O_CREAT/.test(m[3] ?? "")) continue;
        let path: string;
        try {
          path = realpathSync(resolve(ROOT, m[2]!));
        } catch {
          continue; // gone by now: a temporary file
        }
        if (path !== ROOT && !path.startsWith(ROOT + sep)) continue;
        const rel = relative(ROOT, path);
        if (c.tree && (c.docs || !isProse(rel))) continue; // Keyed on the tree: every file of it is covered.
        let isDir = false;
        try {
          isDir = statSync(path).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          // A directory read or checked: its listing is an input only the tree hash covers. The resolver's own are
          // the ancestors of the key's files, node_modules and git's.
          if (ancestors.has(rel) || /(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) continue;
          if (!dirs.has(rel)) continue; // Holds no tracked file: not part of the tree either.
          missed.add(`${rel}/`);
          continue;
        }
        // Outside the key by design: installed packages (bun.lock), git's files, ignored files.
        if (!tree.has(rel)) continue;
        reads.add(rel);
        if (covered.has(rel) || config.has(rel)) continue;
        missed.add(rel);
      }
      const bound = !c.tree ? `${closureHash(c.files)} ${test}` : null;
      done({ test, missed: [...missed].sort(), failed: code !== 0, reads: [...reads].sort(), bound });
    });
  });
}

const findings: Finding[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: jobs }, async (_, slot) => {
    while (next < tests.length) findings.push(await audit(tests[next++]!, slot));
  }),
);
rmSync(tmp, { recursive: true, force: true });
if (readsFile) writeFileSync(readsFile, JSON.stringify(Object.fromEntries(findings.map((f) => [f.test, f.reads]))));
const bad = findings.filter((f) => f.missed.length > 0).sort((a, b) => a.test.localeCompare(b.test));
for (const f of bad) {
  console.log(`${f.test}: reads ${f.missed.length} files its key does not cover`);
  for (const m of f.missed.slice(0, 12)) console.log(`  ${m}`);
  if (f.missed.length > 12) console.log(`  ... and ${f.missed.length - 12} more`);
}
if (argv.includes("--write")) {
  // Tests that read files, were traced reading nothing outside their key, and passed: bound to their closure's bytes.
  const lines = findings
    .filter((f) => f.bound && f.missed.length === 0 && !f.failed)
    .map((f) => f.bound!)
    .sort((a, b) => a.slice(41).localeCompare(b.slice(41)));
  writeFileSync(join(ROOT, VERIFIED), lines.join("\n") + (lines.length ? "\n" : ""));
  console.log(`test-cache-audit: wrote ${lines.length} verified tests to ${VERIFIED}`);
}
const failed = findings.filter((f) => f.failed).map((f) => f.test);
if (failed.length > 0) console.log(`failed under strace (timing tests can): ${failed.join(", ")}`);
console.log(`test-cache-audit: ${findings.length} test files traced, ${bad.length} read a file outside their key`);
process.exit(bad.length > 0 ? 1 : 0);
