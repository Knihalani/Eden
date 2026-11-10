#!/usr/bin/env bun
/**
 * A result cache for test files (D650): a test file is skipped when it last passed on exactly the inputs it has now.
 *
 *   bun scripts/test-cache.ts plan <state-file> <test files...>     prints the files that must run, one per line
 *   bun scripts/test-cache.ts record <state-file> <junit.xml>       records the files that passed, if still unchanged
 *   bun scripts/test-cache.ts why <test file>                       prints what the file's key covers
 *
 * A file's key is a hash of:
 *
 * - the run's environment: Bun's version, platform, `bun.lock`, `bunfig.toml`, the preload, every `tsconfig*.json`
 *   and `package.json` outside archived/, `python3 --version`, the core count, and the names and values of the
 *   environment variables a test can see (`ENV_NAMES`);
 * - the file itself and every file it reaches through imports: static and literal dynamic imports, and
 *   `new URL("./x", import.meta.url)` (how workers and child scripts are named), resolved as Bun resolves them.
 *   Imports that land in node_modules are covered by `bun.lock`;
 * - for a file that can read the repository some other way (`needsTree`: it, or a module it reaches, spawns a
 *   process, asks where it is on disk, or names a repository path in a string), every file of the repository that
 *   git does not ignore, outside archived/. Such a file is skipped only when nothing in the repository changed.
 *
 * So a skipped file is one whose every reachable input is byte-identical to a run in which it passed. What the key
 * cannot see is a test that depends on the date, on the network, or on files outside the repository; none should
 * (docs/TESTING.md), and entries older than `MAX_AGE_MS` are run again. `CHECK_COLD=1` or `TEST_CACHE=0` runs
 * everything (scripts/test.sh).
 *
 * The passed set is one file shared by every worktree of the repository, as scripts/format.sh's is: lines of
 * `<key> <unix ms> <path>`, capped, written by rename.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = realpathSync(process.env.EDEN_TEST_CACHE_ROOT || join(import.meta.dir, ".."));
/** A pass older than this is run again: a bound on what a date-dependent test could hide. */
export const MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_LINES = 20_000;
/**
 * Variables a test can see that change what it does. scripts/test-preload.ts clears EDEN_* and OPENROUTER_* in the
 * test process, but a value set by the caller of `bun test` (KG_DIFF_SEEDS was one) or read before the preload counts.
 */
const ENV_NAMES = /^(BUN_|NODE_|TEST_|EDEN_|OPENROUTER_|HAIKU_|ANTHROPIC_|MODAL_|TZ$|CI$|LANG$|LC_)/;

/**
 * Signs that a module can read files the import graph does not show: it starts a process, learns its own location
 * (other than to name a sibling module, which `URL_EDGE` follows), reads the working directory, or imports a module
 * named at run time. Reading or listing a path is not a sign by itself: a path into the repository has to come from
 * one of these, or from a string that names it (`REPO_PATH`); the rest are temporary directories.
 */
const TREE_SIGNS = [
  /["']node:child_process["']|["']child_process["']/,
  /\bBun\.spawn(Sync)?\b|\bBun\.\$|import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,
  /\bimport\.meta\.(dir|dirname|path|filename|resolve|resolveSync)\b/,
  /\b__dirname\b|\b__filename\b/,
  /\bprocess\.cwd\s*\(/,
  /\bBun\.Glob\b|\bglob(Sync)?\s*\(/,
  /\bBun\.resolve(Sync)?\s*\(/,
  /\brequire\s*\(\s*[^"'`\s)]/,
  /\bimport\s*\(\s*[^"'`\s)]/,
];
/** A string that names a path inside the repository: read relative to the working directory, most likely. */
const REPO_PATH = /["'`](?:\.{1,2}\/)*(?:docs|packages|examples|scripts|bench|native)\/[\w@.-]/;
/**
 * Strings that name prose: a path through docs/, or a Markdown file. A module without one does not read prose, so
 * prose is left out of the tree it is keyed on (`treeHash`): an edit to a research note re-runs only the tests that can
 * read notes. `DOCS_SEGMENT` is a path built from parts (`join(import.meta.dir, "..", "docs", ...)`); it counts only
 * beside a location sign, because "docs" alone is also a connector's id.
 */
const DOCS_PATH = /["'`][^"'`\n]*(?:\bdocs\/[\w.@-]|\.md["'`])/;
const DOCS_SEGMENT = /["'`]docs["'`]/;
/** Prose: docs/ and Markdown anywhere. */
export const isProse = (p: string) => p.startsWith("docs/") || p.endsWith(".md");
/** `new URL("./worker.ts", import.meta.url)`: a module named by its file, followed as an import. */
const URL_EDGE = /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
/** `export const X = import.meta.url;`: a module naming itself (for a worker pool to load): already in the graph. */
const URL_SELF = /\bconst \w+ = import\.meta\.url;/g;
/** Any other use of `import.meta.url` is a module learning its location. */
const URL_OTHER = /\bimport\.meta\.url\b/g;
/**
 * Modules whose sign is known to read nothing outside the graph, with why. Checked by `scripts/test-cache-audit.ts`,
 * which traces the files each test really opens.
 */
const TRUSTED: Record<string, string> = {
  // `import(options.module)`: its callers pass their own URL (`URL_SELF`) or a sibling's (`URL_EDGE`), both edges.
  "packages/primitives/src/pool.ts": "imports the module its caller names",
  "packages/primitives/src/pool-worker.ts": "imports the module the pool was given",
};

const hasher = () => new Bun.CryptoHasher("sha256");
const contentHash = new Map<string, string>();
/** The hash of a file's bytes, or "-" when it is not there (a deleted file is a different input). */
function hashOf(path: string): string {
  let h = contentHash.get(path);
  if (h === undefined) {
    try {
      h = hasher().update(readFileSync(path)).digest("hex");
    } catch {
      h = "-";
    }
    contentHash.set(path, h);
  }
  return h;
}

interface Module {
  /** Repository files this module names (imports, sibling URLs), absolute. */
  edges: string[];
  /** Why this module can read files the graph does not show, or null. */
  tree: string | null;
  /** It names docs/ or a Markdown file in a string, so the tree it may read includes them. */
  docs: boolean;
}
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
/**
 * Source with its comments blanked, for the sign tests only: a comment that names `docs/x.md` or `import.meta.dir`
 * reads nothing. A `//` counts as a comment at the start of a line or after a space, so a URL in a string stays.
 */
const uncommented = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
const modules = new Map<string, Module>();

function scan(path: string): Module {
  let m = modules.get(path);
  if (m) return m;
  m = { edges: [], tree: null, docs: false };
  modules.set(path, m);
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return m; // JSON, text: a leaf, hashed as bytes
  let code: string;
  try {
    code = readFileSync(path, "utf8");
  } catch {
    return m;
  }
  const names: string[] = [];
  try {
    const t = /\.(tsx|jsx)$/.test(path) ? transpilers.tsx : transpilers.ts;
    for (const i of t.scanImports(code.replace(/^#![^\n]*/, ""))) names.push(i.path);
  } catch {
    m.tree = "does not parse";
  }
  const bare = uncommented(code);
  for (const u of bare.matchAll(URL_EDGE)) names.push(u[1]!);
  const named = [...bare.matchAll(URL_EDGE)].length + (bare.match(URL_SELF) ?? []).length;
  const urlUses = (bare.match(URL_OTHER) ?? []).length - named;
  if (urlUses > 0) m.tree ??= "import.meta.url";
  for (const sign of TREE_SIGNS) if (sign.test(bare)) m.tree ??= String(sign);
  if (REPO_PATH.test(bare)) m.tree ??= "names a repository path";
  m.docs = DOCS_PATH.test(bare) || (m.tree !== null && DOCS_SEGMENT.test(bare));
  if (TRUSTED[relative(ROOT, path)]) m.tree = null;
  const from = dirname(path);
  for (const name of names) {
    if (/^(bun|node):/.test(name) || name === "bun") continue;
    let to: string;
    try {
      to = realpathSync(Bun.resolveSync(name, from));
    } catch {
      // Not resolvable now: a builtin without its prefix, or a file that does not exist yet. The second must change
      // the key when it appears, which only the tree hash can see.
      if (name.startsWith(".") || name.startsWith("@eden/")) m.tree ??= `unresolved ${name}`;
      continue;
    }
    if (!to.startsWith(ROOT + sep) || to.includes(`${sep}node_modules${sep}`)) continue; // bun.lock covers it
    m.edges.push(to);
  }
  return m;
}

/**
 * Every repository file reachable from `entry`, sorted; the first reason it needs the whole tree; whether any module
 * names prose.
 */
export function closure(entry: string): { files: string[]; tree: string | null; docs: boolean } {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  let tree: string | null = null;
  let docs = false;
  while (stack.length > 0) {
    const at = stack.pop()!;
    const m = scan(at);
    if (m.tree && !tree) tree = `${relative(ROOT, at)}: ${m.tree}`;
    docs ||= m.docs;
    for (const e of m.edges) {
      if (seen.has(e)) continue;
      seen.add(e);
      stack.push(e);
    }
  }
  return { files: [...seen].sort(), tree, docs };
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

let listMemo: string[] | null | undefined;
/** Every file git tracks or would track (not ignored), outside archived/, sorted; null without git. */
export function treeFiles(): string[] | null {
  if (listMemo !== undefined) return listMemo;
  const listed = git("ls-files", "-z", "--cached", "--others", "--exclude-standard");
  if (listed === null) return (listMemo = null);
  return (listMemo = [...new Set(listed.split("\0"))].filter((p) => p && !p.startsWith("archived/")).sort());
}

const treeMemo = new Map<boolean, string>();
/** One hash over the tree's paths and bytes; without prose unless `docs`. */
function treeHash(docs: boolean): string {
  let out = treeMemo.get(docs);
  if (out !== undefined) return out;
  const paths = treeFiles();
  if (paths === null) return `no-git-${Date.now()}-${Math.random()}`; // never equal: nothing is skipped
  const h = hasher();
  for (const p of paths) if (docs || !isProse(p)) h.update(`${p}\0${hashOf(join(ROOT, p))}\n`);
  out = h.digest("hex");
  treeMemo.set(docs, out);
  return out;
}

/** The configuration every key covers. */
export function configFiles(): string[] {
  const config = (treeFiles() ?? []).filter((p) => /(^|\/)(package\.json|tsconfig[\w.]*\.json)$/.test(p));
  return ["bun.lock", "bunfig.toml", "scripts/test-preload.ts", "scripts/test.sh", "scripts/test-cache.ts", ...config];
}

let envMemo: string | undefined;
function envHash(): string {
  if (envMemo !== undefined) return envMemo;
  const h = hasher();
  h.update(`bun ${Bun.version} ${Bun.revision} ${process.platform} ${process.arch} cores ${cpus().length}\n`);
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  h.update(`python ${py.status === 0 ? py.stdout.trim() : "none"}\n`);
  for (const k of Object.keys(process.env).sort()) {
    if (ENV_NAMES.test(k) && !k.startsWith("EDEN_TEST_CACHE_")) h.update(`${k}=${process.env[k]}\n`);
  }
  for (const p of configFiles()) h.update(`${p}\0${hashOf(join(ROOT, p))}\n`);
  return (envMemo = h.digest("hex"));
}

export interface Keyed {
  key: string;
  files: number;
  tree: string | null;
  docs: boolean;
}

/** The key of one test file (a path relative to the repository root). */
export function keyOf(test: string): Keyed {
  const { files, tree, docs } = closure(realpathSync(resolve(ROOT, test)));
  const h = hasher();
  h.update(`v1\n${envHash()}\n${test}\n`);
  for (const f of files) h.update(`${relative(ROOT, f)}\0${hashOf(f)}\n`);
  if (tree) h.update(`tree ${docs} ${treeHash(docs)}\n`);
  return { key: h.digest("hex").slice(0, 40), files: files.length, tree, docs };
}

function storePath(): string | null {
  const common = git("rev-parse", "--git-common-dir");
  if (common === null) return null;
  return join(resolve(ROOT, common.trim()), "eden-check-cache", "tests-v1");
}

function readStore(path: string): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{40}) (\d+) \S/.exec(line);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

const norm = (p: string) => p.replace(/^\.\//, "");

function plan(stateFile: string, tests: string[]): void {
  const store = storePath();
  const passed = store ? readStore(store) : new Map<string, number>();
  const now = Date.now();
  const keys: Record<string, string> = {};
  const run: string[] = [];
  let whole = 0;
  for (const t of tests.map(norm)) {
    const k = keyOf(t);
    keys[t] = k.key;
    if (k.tree) whole++;
    const at = passed.get(k.key);
    if (at === undefined || now - at > MAX_AGE_MS || at > now) run.push(t);
  }
  writeFileSync(stateFile, JSON.stringify(keys));
  const skipped = tests.length - run.length;
  process.stderr.write(
    `test cache: ${skipped} of ${tests.length} files passed on these inputs and are skipped, ${run.length} run ` +
      `(${whole} keyed on the whole tree; CHECK_COLD=1 or TEST_CACHE=0 runs all)\n`,
  );
  process.stdout.write(run.map((t) => `./${t}\n`).join(""));
}

function record(stateFile: string, junit: string): void {
  const store = storePath();
  if (!store || !existsSync(stateFile) || !existsSync(junit)) return;
  const keys = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, string>;
  const xml = readFileSync(junit, "utf8");
  // Top-level suites are files: `name` and `file` are the same path. Nested suites (describe blocks) carry a `line`.
  const ok: string[] = [];
  for (const m of xml.matchAll(
    /<testsuite name="([^"]*)" file="([^"]*)" tests="(\d+)"[^>]*? failures="(\d+)"[^>]*>/g,
  )) {
    if (m[1] !== m[2] || / line="/.test(m[0])) continue;
    if (Number(m[4]) === 0 && Number(m[3]) > 0) ok.push(norm(m[2]!));
  }
  const now = Date.now();
  const add: string[] = [];
  for (const t of ok) {
    const before = keys[t];
    // Recorded only if the inputs still hash as they did when the run was planned: an edit made while the tests ran
    // must not be recorded as passing.
    if (before && keyOf(t).key === before) add.push(`${before} ${now} ${t}`);
  }
  if (add.length === 0) return;
  mkdirSync(dirname(store), { recursive: true });
  let lines: string[] = [];
  try {
    lines = readFileSync(store, "utf8").split("\n").filter(Boolean);
  } catch {
    // no store yet
  }
  const fresh = new Set(add.map((l) => l.slice(0, 40)));
  lines = lines.filter((l) => !fresh.has(l.slice(0, 40)) && now - Number(l.split(" ")[1]) <= MAX_AGE_MS);
  lines.push(...add);
  if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
  const tmp = `${store}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, store);
}

if (import.meta.main) {
  const [mode, a, ...rest] = process.argv.slice(2);
  if (mode === "plan" && a) plan(a, rest);
  else if (mode === "record" && a && rest[0]) record(a, rest[0]);
  else if (mode === "why" && a) {
    const t = norm(a);
    const k = keyOf(t);
    const { files } = closure(realpathSync(resolve(ROOT, t)));
    const scope = k.docs ? "the whole tree" : "the whole tree without prose";
    console.log(`${t}: key ${k.key}, ${k.files} files by import${k.tree ? `, and ${scope} (${k.tree})` : ""}`);
    for (const f of files) console.log(`  ${relative(ROOT, f)}`);
    const store = storePath();
    const at = store ? readStore(store).get(k.key) : undefined;
    console.log(at ? `passed on these inputs ${new Date(at).toISOString()}` : "no recorded pass on these inputs");
  } else {
    console.error("usage: test-cache.ts plan <state> <tests...> | record <state> <junit.xml> | why <test>");
    process.exit(2);
  }
}
