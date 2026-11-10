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
 * - the run's environment: Bun's, Node's and Python's versions, platform, core count, `bun.lock`, `bunfig.toml`, the
 *   preload and what it imports, the root's `.env*` files, every `tsconfig*.json` and `package.json` outside
 *   archived/, and every environment variable but the shell's own (`VOLATILE_ENV`);
 * - the file itself and every file it reaches through imports: static and literal dynamic imports, and
 *   `new URL("./x", import.meta.url)` (how workers and child scripts are named), resolved as Bun resolves them.
 *   Imports that land in node_modules are covered by `bun.lock`;
 * - for a file that can read the repository some other way, every file of the repository that git does not ignore,
 *   outside archived/ (prose only when a string names it or a process is started). That is a file which, or a module
 *   it reaches: shows a sign (`TREE_SIGNS`, `repoPath`: it starts a process, asks where it is on disk, reads a
 *   relative path, names a repository path); or imports the file system at all, unless the audit traced this test
 *   on these bytes reading nothing outside its key (`VERIFIED`, D657).
 *
 * So a skipped file is one whose every reachable input is byte-identical to a run in which it passed. What the key
 * cannot see is a test that depends on the date, on the network, or on files outside the repository or ignored by
 * git (`.local/`: no test reads them, and the audit skips them too); none should
 * (docs/TESTING.md), and entries older than `MAX_AGE_MS` (a day) are run again. It is for the loop: the gate before a
 * merge is `CHECK_COLD=1 bun run check`, which runs everything, as `TEST_CACHE=0` does (scripts/test.sh).
 *
 * The passed set is one file shared by every worktree of the repository, as scripts/format.sh's is: lines of
 * `<key> <unix ms> <path>`, capped, written by rename.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = realpathSync(process.env.EDEN_TEST_CACHE_ROOT || join(import.meta.dir, ".."));
/** A pass older than this is run again: a bound on what a date-dependent test could hide. */
export const MAX_AGE_MS = 24 * 3_600_000;
const MAX_LINES = 20_000;
/**
 * Every environment variable is part of the key (a test can read any: FUZZ_SEEDS=1 runs a weaker fuzz, and its pass
 * must not stand for the full one), except these, which differ between two shells on one tree and which no test
 * should read: the shell's own bookkeeping, the terminal, the session, and directories the run replaces (HOME, TMPDIR).
 */
const VOLATILE_ENV =
  /^(PWD|OLDPWD|SHLVL|_|HOME|TMPDIR|TEMP|TMP|USER|LOGNAME|HOSTNAME|SHELL|EDITOR|VISUAL|PAGER|LS_COLORS|COLUMNS|LINES|DISPLAY|WINDOWID|XAUTHORITY|MAIL|LESS.*|TERM.*|COLORTERM|SSH_.*|XDG_.*|DBUS_.*|GPG_.*|TMUX.*|STY|WINDOW|INVOCATION_ID|JOURNAL_STREAM|EDEN_TEST_CACHE_.*|CLAUDE.*|npm_.*|BUN_INSTALL.*|INIT_CWD|P9K_.*|VSCODE_.*)$/;

/**
 * Signs that a module can read files the import graph does not show: it starts a process, learns its own location
 * (other than to name a sibling module, which `URL_EDGE` follows), reads the working directory, or imports a module
 * named at run time (a variable, a template), or reads a path that is not absolute. A read of an absolute path made
 * at run time shows none of these: that is what `FS_USE` and the audit's record are for.
 */
/** Bun's module or node's built-ins reached indirectly: may spawn or read files, so it counts as both. */
const BUN_INDIRECT =
  /\bfrom\s*["']bun["']|\brequire\s*\(\s*["']bun["']\s*\)|=\s*Bun\b(?!\s*\.)|\bBun\s*\[|\bgetBuiltinModule\b/;
/** `import(` or `require(` of anything but one string literal closed by `)` or `,`. */
const RUNTIME_NAMED = [/\brequire\s*\(\s*(?!["'][^"'\n]*["']\s*[),])/, /\bimport\s*\(\s*(?!["'][^"'\n]*["']\s*[),])/];
const TREE_SIGNS = [
  /["']node:child_process["']|["']child_process["']/,
  /\bBun\.spawn(Sync)?\b|\bBun\.\$|import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,
  /\bimport\.meta\.(dir|dirname|path|filename|resolve|resolveSync|require)\b/,
  /\b__dirname\b|\b__filename\b/,
  /\bprocess\.cwd\s*\(/,
  /\bBun\.Glob\b|\bglob(Sync)?\s*\(/,
  /\bBun\.resolve(Sync)?\s*\(/,
  // A module named at run time: a variable, or a template (`import(\`./${name}.json\`)`).
  // Anything but one string literal closed by `)` or `,`: `import("./w" + ".ts")` names a module at run time too.
  ...RUNTIME_NAMED,
  // Bun's own module reached any other way than `Bun.x`: `import { file } from "bun"`, `import * as B from "bun"`,
  // `const { spawnSync } = Bun`, `Bun["spawn"]`, and node's modules by `process.getBuiltinModule` (review of D657).
  BUN_INDIRECT,
  // A file read by a path that is not absolute: relative to the working directory, which is the repository.
  /\b(readFileSync|readFile|readdirSync|readdir|opendirSync|opendir|existsSync|statSync|lstatSync|accessSync|openSync|createReadStream|Bun\.file)\s*\(\s*["'`](?!\/)/,
];

/** The repository's top-level names (`git ls-files`), for `repoPath`: its directories, and the files at its root. */
function topLevel(): { dirs: string[]; files: string[] } {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const p of treeFiles() ?? []) {
    const cut = p.indexOf("/");
    if (cut < 0) files.add(p);
    else dirs.add(p.slice(0, cut));
  }
  return { dirs: [...dirs], files: [...files] };
}
const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let repoPathMemo: RegExp | undefined;
/**
 * A string that names a path inside the repository, read relative to the working directory most likely: one that
 * starts (after any `./` or `../`) with a top-level directory and a slash, one that is exactly a root file's name
 * (`"LICENSE"`, `"Dockerfile"`), or a top-level directory as the first part of a `join` or `resolve`.
 */
function repoPath(): RegExp {
  if (repoPathMemo) return repoPathMemo;
  const { dirs, files } = topLevel();
  const d = dirs.map(quote).join("|") || "\\0";
  const f = files.map(quote).join("|") || "\\0";
  return (repoPathMemo = new RegExp(
    `["'\`](?:\\.{1,2}/)*(?:${d})/|["'\`](?:\\.{1,2}/)*(?:${f})["'\`]|\\b(?:join|resolve)\\s*\\(\\s*["'\`](?:${d})["'\`]`,
  ));
}
/**
 * Strings that name prose: a path through docs/, a Markdown file, or a bare "docs" beside another sign (a path built
 * from parts; alone it is also a connector's id). A module without one does not read prose, so prose is left out of
 * the tree it is keyed on (`treeHash`): an edit to a research note re-runs only the tests that can read notes. A
 * string that names prose is a tree sign too (`"README.md"` is read from the working directory).
 */
const DOCS_PATH = /["'`][^"'`\n]*(?:\bdocs\/[\w.@-]|\.md["'`])/;
const DOCS_SEGMENT = /["'`]docs["'`]/;
/** Prose: docs/ and Markdown anywhere. */
export const isProse = (p: string) => p.startsWith("docs/") || p.endsWith(".md");
/** A module that starts a process (the first two `TREE_SIGNS`). */
const SPAWNS = new RegExp(
  /["'](?:node:)?child_process["']|\bBun\.spawn(Sync)?\b|\bBun\.\$|/.source + BUN_INDIRECT.source,
);
/** A module that reads files itself: keyed on the tree unless the audit traced its test (`verified`). */
const FS_USE = new RegExp(
  /["'](?:node:)?fs(?:\/promises)?["']|\bBun\.(?:file|write)\s*\(|/.source + BUN_INDIRECT.source,
);
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
  /** It imports the file system or opens files through Bun (`FS_USE`). */
  fs: boolean;
}
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
/**
 * The source as the transpiler prints it, for the sign tests: comments gone (one that names `docs/x.md` or
 * `import.meta.dir` reads nothing) and strings intact, which a regular expression over the text cannot tell apart
 * (`"fixtures/*.tmp"` opened a comment for it). When it does not transpile, the source itself: more signs, never fewer.
 */
function uncommented(code: string, t: Bun.Transpiler): string {
  try {
    return t.transformSync(code.replace(/^#![^\n]*/, ""));
  } catch {
    return code;
  }
}

const modules = new Map<string, Module>();

function scan(path: string): Module {
  let m = modules.get(path);
  if (m) return m;
  m = { edges: [], tree: null, docs: false, fs: false };
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
  const bare = uncommented(code, /\.(tsx|jsx)$/.test(path) ? transpilers.tsx : transpilers.ts);
  for (const u of bare.matchAll(URL_EDGE)) names.push(u[1]!);
  const named = [...bare.matchAll(URL_EDGE)].length + (bare.match(URL_SELF) ?? []).length;
  const urlUses = (bare.match(URL_OTHER) ?? []).length - named;
  if (urlUses > 0) m.tree ??= "import.meta.url";
  for (const sign of TREE_SIGNS) if (sign.test(bare)) m.tree ??= String(sign);
  // The transpiler folds constants (`import("./w" + ".ts")` prints as one literal), so a module named at run time is
  // also looked for in the source as written. A match inside a comment only re-runs more: the safe direction.
  for (const sign of RUNTIME_NAMED) if (sign.test(code)) m.tree ??= String(sign);
  if (repoPath().test(bare)) m.tree ??= "names a repository path";
  if (DOCS_PATH.test(bare)) m.tree ??= "names prose";
  m.docs = DOCS_PATH.test(bare) || (m.tree !== null && DOCS_SEGMENT.test(bare));
  // A process it starts can read anything, prose too (the Modal apps' Python tests read their README).
  if (SPAWNS.test(bare)) m.docs = true;
  m.fs = FS_USE.test(bare);
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
export function closure(entry: string): { files: string[]; tree: string | null; docs: boolean; fs: boolean } {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  let tree: string | null = null;
  let docs = false;
  let fs = false;
  while (stack.length > 0) {
    const at = stack.pop()!;
    const m = scan(at);
    if (m.tree && !tree) tree = `${relative(ROOT, at)}: ${m.tree}`;
    docs ||= m.docs;
    fs ||= m.fs;
    for (const e of m.edges) {
      if (seen.has(e)) continue;
      seen.add(e);
      stack.push(e);
    }
  }
  return { files: [...seen].sort(), tree, docs, fs };
}

/** One hash over a closure's paths and bytes: what the audit's record of a test (`VERIFIED`) is bound to. */
export function closureHash(files: readonly string[]): string {
  const h = hasher();
  for (const f of files) h.update(`${relative(ROOT, f)}\0${hashOf(f)}\n`);
  return h.digest("hex").slice(0, 40);
}

/**
 * Tests the audit traced reading nothing outside their key (`scripts/test-cache-audit.ts --write`), each bound to its
 * closure's bytes then: `<closure hash> <test path>` a line. A test whose closure reads files (`FS_USE`) is keyed on
 * the tree unless its line here still matches, so an edit anywhere in its closure sends it back to the tree until
 * the audit runs again. A missing or stale file only makes more tests run.
 */
export const VERIFIED = "scripts/test-cache-verified.txt";
let verifiedMemo: Set<string> | undefined;
function verified(test: string, hash: string): boolean {
  if (!verifiedMemo) {
    verifiedMemo = new Set();
    try {
      for (const line of readFileSync(join(ROOT, VERIFIED), "utf8").split("\n")) {
        if (/^[0-9a-f]{40} \S/.test(line)) verifiedMemo.add(line);
      }
    } catch {
      // No record: nothing is verified.
    }
  }
  return verifiedMemo.has(`${hash} ${test}`);
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

let listMemo: string[] | null | undefined;
/** Every file git tracks or would track (not ignored), outside archived/, sorted; null without git. */
export function treeFiles(): string[] | null {
  if (listMemo !== undefined) return listMemo;
  // Without the user's own excludes file: what is "not ignored" must not depend on whose machine this is.
  const listed = git(
    "-c",
    "core.excludesFile=/dev/null",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  );
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
  // The preload and what it imports run in every test; Bun loads the root's .env files (.env, .env.test,
  // .env.local) into every test's environment, tracked or not.
  const preload = closure(join(ROOT, "scripts/test-preload.ts")).files.map((f) => relative(ROOT, f));
  let env: string[] = [];
  try {
    env = readdirSync(ROOT).filter((n) => n.startsWith(".env"));
  } catch {
    // No listing: the tracked ones are in the tree hash at least.
  }
  const fixed = ["bun.lock", "bunfig.toml", "scripts/test.sh", "scripts/test-cache.ts", VERIFIED];
  return [...new Set([...fixed, ...preload, ...env.sort(), ...config])];
}

let envMemo: string | undefined;
function envHash(): string {
  if (envMemo !== undefined) return envMemo;
  const h = hasher();
  h.update(`bun ${Bun.version} ${Bun.revision} ${process.platform} ${process.arch} cores ${cpus().length}\n`);
  for (const tool of ["python3", "node"]) {
    const v = spawnSync(tool, ["--version"], { encoding: "utf8" });
    h.update(`${tool} ${v.status === 0 ? v.stdout.trim() : "none"}\n`);
  }
  for (const k of Object.keys(process.env).sort()) {
    if (!VOLATILE_ENV.test(k)) h.update(`${k}=${process.env[k]}\n`);
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
  const c = closure(realpathSync(resolve(ROOT, test)));
  const { files, docs } = c;
  // Fail closed (the review of D650): a closure that opens files by paths the signs cannot see is keyed on the tree
  // until the audit has traced this test on these very bytes.
  const tree = c.tree ?? (c.fs && !verified(test, closureHash(files)) ? "reads files, not traced by the audit" : null);
  const h = hasher();
  h.update(`v2\n${envHash()}\n${test}\n`);
  for (const f of files) h.update(`${relative(ROOT, f)}\0${hashOf(f)}\n`);
  if (tree) h.update(`tree ${docs} ${treeHash(docs)}\n`);
  return { key: h.digest("hex").slice(0, 40), files: files.length, tree, docs };
}

function storePath(): string | null {
  const common = git("rev-parse", "--git-common-dir");
  if (common === null) return null;
  return join(resolve(ROOT, common.trim()), "eden-check-cache", "tests-v2");
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
    // A file whose tests were all skipped proved nothing (`test.skipIf` on a missing tool): not a pass.
    const skipped = Number(/ skipped="(\d+)"/.exec(m[0])?.[1] ?? 0);
    if (Number(m[4]) === 0 && Number(m[3]) - skipped > 0) ok.push(norm(m[2]!));
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
    const tree = k.tree ? `, and ${scope} (${k.tree})` : "";
    console.log(`${t}: key ${k.key}, ${k.files} files by import (closure ${closureHash(files)})${tree}`);
    for (const f of files) console.log(`  ${relative(ROOT, f)}`);
    const store = storePath();
    const at = store ? readStore(store).get(k.key) : undefined;
    console.log(at ? `passed on these inputs ${new Date(at).toISOString()}` : "no recorded pass on these inputs");
  } else {
    console.error("usage: test-cache.ts plan <state> <tests...> | record <state> <junit.xml> | why <test>");
    process.exit(2);
  }
}
