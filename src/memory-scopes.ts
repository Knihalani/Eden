/**
 * The scope catalog (D3, A4 §2): the folders of a repo where a fact can be true, derived by R5 §9.2's rule from the
 * main checkout's files, persisted as the repo store's `scopes.json`, and looked up by longest prefix without touching
 * the filesystem.
 *
 * - **Files** (step 1): `git ls-files -z -co --exclude-standard` in the main checkout, so `node_modules`, ignored
 *   build output and nested worktrees never count. Never a filesystem walk (R5 §8: 30–70× slower, and wrong).
 * - **Scopes** (steps 2–9): `""`, every manifest directory that no VENDOR, TEST or EXAMPLE segment excludes, every
 *   workspace member (a member is never excluded), one bucket per EXAMPLE tree, minus scopes owning only their
 *   manifest (min-2, deepest first), plus the top-level folders of a Bazel/Buck/Pants root where `""` owns most files,
 *   then the `.eden/scopes` override.
 * - **Paths** (§9.1): a path belongs to the repo of its own worktree, relative to that worktree's top, so an agent
 *   worktree's `packages/know/src/a.ts` is the main checkout's `packages/know`.
 * - **Waiting** (R5 §10): the directories min-2 dropped. A file written into one makes it a scope, so a new package
 *   becomes one when its second file is written, not at the next sleep.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../packages/cli/src/home";
import { memoryNow } from "./memory-clock";
import { gitPlace, mainCheckout, repoKeyOf } from "./memory-repo";

export interface ScopeCatalog {
  /** When it was built (`memoryNow`). */
  built: number;
  /** The main checkout it was built from: the idle sleep rebuilds from it. */
  checkout: string;
  /** Sorted; `""` (the repo root) always first. */
  scopes: string[];
  /** Directories whose manifest is all they own (step 7; see the header). */
  waiting: string[];
}

/** A path in a repo (§9.1): the repo's key (D1), its own worktree's top, and the path relative to it with `/`. */
export interface RepoPath {
  repo: string;
  top: string;
  rel: string;
}

const CATALOG = "scopes.json";
/** The override (step 9), tracked in the repo. */
export const SCOPES_OVERRIDE = ".eden/scopes";
/** How long a rebuild may list files at the end of a turn or at sleep; a batch passes less (it blocks the agent). */
const LIST_TIMEOUT_MS = 30_000;

/** Step 2: manifests that count whatever they say. */
const PLAIN_MANIFESTS = new Set([
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "deno.json",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "mix.exs",
  "Package.swift",
  "pubspec.yaml",
]);
const MANIFEST_SUFFIXES = [".gemspec", ".csproj", ".fsproj"];
const PROJECT_LINE = /^\s*project\s*\(/m;
/** Step 2: manifests that count only for what they say. */
const CONTENT_MANIFESTS: Record<string, (text: string) => boolean> = {
  "package.json": (text) => {
    const name = jsonObject(text)?.name;
    return typeof name === "string" && name.trim() !== "";
  },
  "setup.cfg": (text) => sectionHasName(text, "metadata"),
  DESCRIPTION: (text) => /^\s*Package:/.test(text),
  "CMakeLists.txt": (text) => PROJECT_LINE.test(text),
  "meson.build": (text) => PROJECT_LINE.test(text),
};
/** Step 2: nx's project files count when the repo has an `nx.json`. */
const NX_PROJECT = "project.json";
const NX_ROOT = "nx.json";
/** Step 3: the files that declare workspace members. */
const WORKSPACE_FILES = new Set(["package.json", "pnpm-workspace.yaml", "Cargo.toml", "go.work", "pyproject.toml"]);

/** Step 4's segment classes. */
const VENDOR = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "external",
  "dist",
  "build",
  "out",
  "target",
  "compiled",
  "precompiled",
]);
const TEST = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "snapshots",
  "fixtures",
  "fixture",
  "__fixtures__",
  "testdata",
  "test-data",
  "testcases",
  "e2e",
  "integration-tests",
]);
const EXAMPLE = new Set([
  "examples",
  "example",
  "samples",
  "sample",
  "templates",
  "template",
  "starters",
  "boilerplates",
  "archived",
  "attic",
  "legacy",
  "deprecated",
]);

/** Step 8. */
const BUILD_SYSTEM_ROOTS = ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel", "BUCK", ".buckconfig", "pants.toml"];
const TOP_LEVEL_SCOPE_FILES = 200;
const NOT_TOP_LEVEL_SCOPES = new Set(["src", "lib", "source", "include", "docs", "doc"]);

/** Step 7: a scope other than the root owns at least this many files. */
const MIN_FILES = 2;

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an INI file's `[section]` sets `name =`. */
function sectionHasName(text: string, section: string): boolean {
  let inSection = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) inSection = header[1]!.trim() === section;
    else if (inSection && /^\s*name\s*=/.test(line)) return true;
  }
  return false;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

const segments = (dir: string) => (dir ? dir.split("/") : []);
const depth = (dir: string) => segments(dir).length;

/** Step 4: a segment that excludes its directory (case-insensitive; a dot, or a single `_` as Go reads it). */
function excludingSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    VENDOR.has(lower) || TEST.has(lower) || EXAMPLE.has(lower) || segment.startsWith(".") || /^_(?!_)/.test(segment)
  );
}

function excludedBySegment(dir: string): boolean {
  return segments(dir).some(excludingSegment);
}

/** Step 5: the bucket an excluded directory falls in: the path to its first excluded segment, if an EXAMPLE one. */
function bucketOf(dir: string): string | undefined {
  const parts = segments(dir);
  const first = parts.findIndex(excludingSegment);
  return first >= 0 && EXAMPLE.has(parts[first]!.toLowerCase()) ? parts.slice(0, first + 1).join("/") : undefined;
}

function isManifest(file: string, read: (path: string) => string | undefined, nx: boolean): boolean {
  const name = basename(file);
  if (PLAIN_MANIFESTS.has(name) || MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (name === NX_PROJECT) return nx;
  const says = CONTENT_MANIFESTS[name];
  if (!says) return false;
  const text = read(file);
  return text !== undefined && says(text);
}

/** A workspace declaration (step 3): the declaring file's directory, and its member globs and exclusions. */
interface Declaration {
  dir: string;
  include: string[];
  exclude: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A glob list where `!glob` excludes (npm, pnpm). */
function signedGlobs(dir: string, globs: string[]): Declaration {
  return {
    dir,
    include: globs.filter((glob) => !glob.startsWith("!")),
    exclude: globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1)),
  };
}

function tomlTable(text: string, path: string[]): Record<string, unknown> | undefined {
  if (!text.includes("workspace")) return undefined;
  try {
    let table: unknown = Bun.TOML.parse(text);
    for (const key of path) table = (table as Record<string, unknown> | undefined)?.[key];
    return table && typeof table === "object" ? (table as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `go.work`'s `use` directives, one per line or in a block. */
function goWorkUses(text: string): string[] {
  const uses: string[] = [];
  const body = text.replace(/\/\/.*$/gm, "");
  for (const block of body.matchAll(/^\s*use\s*\(([^)]*)\)/gm)) uses.push(...block[1]!.split(/\s+/).filter(Boolean));
  for (const line of body.matchAll(/^\s*use\s+([^\s(]+)\s*$/gm)) uses.push(line[1]!);
  return uses.map((use) => use.replace(/^"|"$/g, ""));
}

function declarationIn(file: string, text: string): Declaration | undefined {
  const dir = parentOf(file);
  switch (basename(file)) {
    case "package.json": {
      const workspaces = jsonObject(text)?.workspaces;
      const globs = Array.isArray(workspaces)
        ? strings(workspaces)
        : strings((workspaces as { packages?: unknown } | undefined)?.packages);
      return globs.length ? signedGlobs(dir, globs) : undefined;
    }
    case "pnpm-workspace.yaml": {
      try {
        const globs = strings((Bun.YAML.parse(text) as { packages?: unknown } | null)?.packages);
        return globs.length ? signedGlobs(dir, globs) : undefined;
      } catch {
        return undefined;
      }
    }
    case "Cargo.toml":
    case "pyproject.toml": {
      const table = tomlTable(text, basename(file) === "Cargo.toml" ? ["workspace"] : ["tool", "uv", "workspace"]);
      const include = strings(table?.members);
      return include.length ? { dir, include, exclude: strings(table?.exclude) } : undefined;
    }
    case "go.work": {
      const include = goWorkUses(text);
      return include.length ? { dir, include, exclude: [] } : undefined;
    }
  }
  return undefined;
}

/** A glob as written in a declaration or the override, made comparable to a directory path: no `./`, no `/` end. */
function normalizedGlob(glob: string): string {
  return glob
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
}

function globMatcher(globs: string[]): (path: string) => boolean {
  const matchers = globs.map(normalizedGlob).map((glob) => {
    if (glob === "" || glob === ".") return (path: string) => path === "";
    const compiled = new Bun.Glob(glob);
    return (path: string) => compiled.match(path);
  });
  return (path) => matchers.some((matches) => matches(path));
}

/** Step 3: the candidates a declaration's globs match, relative to its own directory. */
function membersOf(declaration: Declaration, candidates: readonly string[]): string[] {
  const included = globMatcher(declaration.include);
  const excluded = globMatcher(declaration.exclude);
  const prefix = declaration.dir ? `${declaration.dir}/` : "";
  return candidates.filter((dir) => {
    if (dir !== declaration.dir && !dir.startsWith(prefix)) return false;
    const rel = dir === declaration.dir ? "" : dir.slice(prefix.length);
    return included(rel) && !excluded(rel);
  });
}

/**
 * Step 3's members. A declaration whose own directory is excluded is ignored, unless that directory is itself a
 * member (step 4's exception), so the members grow until no declaration adds one.
 */
function workspaceMembers(declarations: readonly Declaration[], candidates: readonly string[]): Set<string> {
  let members = new Set<string>();
  for (;;) {
    const read = declarations.filter((d) => !excludedBySegment(d.dir) || members.has(d.dir));
    const next = new Set(read.flatMap((declaration) => membersOf(declaration, candidates)));
    if (next.size === members.size) return next;
    members = next;
  }
}

/** The scope owning a directory: the longest scope prefixing it on a `/` boundary (step 10). */
export function scopeOfDir(scopes: Iterable<string>, dir: string): string {
  let best = "";
  for (const scope of scopes)
    if (scope.length > best.length && (dir === scope || dir.startsWith(`${scope}/`))) best = scope;
  return best;
}

/** The scope owning a file: its directory's (step 10). */
export function scopeOfFile(scopes: Iterable<string>, file: string): string {
  return scopeOfDir(scopes, parentOf(file));
}

/** How many files each scope owns. */
function ownedCounts(scopes: ReadonlySet<string>, files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>([...scopes].map((scope) => [scope, 0]));
  for (const file of files) {
    let dir = parentOf(file);
    while (dir && !scopes.has(dir)) dir = parentOf(dir);
    counts.set(dir, counts.get(dir)! + 1);
  }
  return counts;
}

/** Step 7: drops, deepest first, each scope owning fewer than 2 files; its files go to its nearest ancestor scope. */
function dropSmall(scopes: Set<string>, files: readonly string[]): string[] {
  const counts = ownedCounts(scopes, files);
  const dropped: string[] = [];
  for (const scope of [...scopes].sort((a, b) => depth(b) - depth(a))) {
    if (scope === "" || counts.get(scope)! >= MIN_FILES) continue;
    scopes.delete(scope);
    const heir = scopeOfDir(scopes, parentOf(scope));
    counts.set(heir, counts.get(heir)! + counts.get(scope)!);
    dropped.push(scope);
  }
  return dropped;
}

/** Step 8: at a Bazel/Buck/Pants root where `""` owns over half the files, its big top-level folders are scopes. */
function addTopLevelScopes(scopes: Set<string>, files: readonly string[]): void {
  if (!files.some((file) => BUILD_SYSTEM_ROOTS.includes(file))) return;
  const atRoot = files.filter((file) => scopeOfFile(scopes, file) === "");
  if (atRoot.length * 2 <= files.length) return;
  const sizes = new Map<string, number>();
  for (const file of atRoot) {
    const top = segments(file)[0]!;
    if (top !== file) sizes.set(top, (sizes.get(top) ?? 0) + 1);
  }
  for (const [top, size] of sizes)
    if (size >= TOP_LEVEL_SCOPE_FILES && !NOT_TOP_LEVEL_SCOPES.has(top) && !excludingSegment(top)) scopes.add(top);
}

/** Every directory holding a file, at any depth. */
function directoriesOf(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) for (let dir = parentOf(file); dir && !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir);
  return dirs;
}

/** Step 9: each line of `.eden/scopes` adds the directories its glob matches; a `!glob` line removes scopes. */
function applyOverride(scopes: Set<string>, files: readonly string[], text: string): void {
  const dirs = directoriesOf(files);
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const remove = line.startsWith("!");
    const glob = normalizedGlob(remove ? line.slice(1) : line);
    if (!glob) continue;
    const matches = globMatcher([glob]);
    if (remove) {
      for (const scope of [...scopes]) if (scope && matches(scope)) scopes.delete(scope);
    } else {
      for (const dir of dirs) if (matches(dir)) scopes.add(dir);
    }
  }
}

/**
 * R5 §9.2 steps 2–9 over a repo's files (paths relative to its top, `/`-separated) and a reader of their text (step
 * 2's and 3's files only). Returns the scopes sorted, and the directories min-2 dropped.
 */
export function deriveScopes(
  files: readonly string[],
  read: (path: string) => string | undefined,
): Pick<ScopeCatalog, "scopes" | "waiting"> {
  const nx = files.includes(NX_ROOT);
  const candidates = [...new Set(files.filter((file) => isManifest(file, read, nx)).map(parentOf))];
  const declarations = files.flatMap((file) => {
    if (!WORKSPACE_FILES.has(basename(file))) return [];
    const text = read(file);
    const declaration = text === undefined ? undefined : declarationIn(file, text);
    return declaration ? [declaration] : [];
  });
  const members = workspaceMembers(declarations, candidates);
  const scopes = new Set<string>([""]);
  for (const dir of candidates) {
    if (members.has(dir) || !excludedBySegment(dir)) scopes.add(dir);
    else {
      const bucket = bucketOf(dir);
      if (bucket) scopes.add(bucket);
    }
  }
  const dropped = dropSmall(scopes, files);
  addTopLevelScopes(scopes, files);
  if (files.includes(SCOPES_OVERRIDE)) applyOverride(scopes, files, read(SCOPES_OVERRIDE) ?? "");
  return { scopes: [...scopes].sort(), waiting: dropped.filter((dir) => !scopes.has(dir)).sort() };
}

/** A path with its links resolved and its case as the filesystem keeps it; a missing tail is kept as written. */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      missing.push(basename(at));
    }
  }
}

/** §9.1: an absolute path's repo, its own worktree's top, and the path relative to it; none outside git. */
export function repoPathOf(path: string): RepoPath | undefined {
  if (!isAbsolute(path)) return undefined;
  const real = canonicalPath(path);
  const place = gitPlace(real);
  if (!place) return undefined;
  const top = canonicalPath(place.top);
  const rel = relative(top, real).split(sep).join("/");
  if (rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return undefined;
  return { repo: repoKeyOf(place.common), top, rel };
}

/** Git's own variables would point it at another repository than the checkout named. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX)$/.test(key)) env[key] = value;
  return env;
}

/** Step 1: a checkout's tracked and untracked-not-ignored files; none when git cannot list them in time. */
export function repoFiles(checkout: string, timeoutMs = LIST_TIMEOUT_MS): string[] | undefined {
  try {
    const run = Bun.spawnSync(["git", "-C", checkout, "ls-files", "-z", "-co", "--exclude-standard"], {
      env: gitEnv(),
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    if (run.exitCode !== 0) return undefined;
    // An untracked nested repo (an agent worktree) is listed as its directory, with a trailing `/`: no file of ours.
    return run.stdout
      .toString()
      .split("\0")
      .filter((entry) => entry && !entry.endsWith("/"));
  } catch {
    return undefined;
  }
}

/** The catalog of the repo a path is in, from its main checkout's files (step 1); none outside git. */
export function catalogOf(from: string, timeoutMs = LIST_TIMEOUT_MS): ScopeCatalog | undefined {
  const place = gitPlace(canonicalPath(from));
  if (!place) return undefined;
  const checkout = canonicalPath(mainCheckout(place));
  const files = repoFiles(checkout, timeoutMs);
  if (!files) return undefined;
  const read = (file: string) => {
    try {
      return readFileSync(join(checkout, file), "utf8");
    } catch {
      return undefined;
    }
  };
  return { built: memoryNow(), checkout, ...deriveScopes(files, read) };
}

/** Builds the catalog of the repo `from` is in and writes it to the repo's store (step 10). */
export function buildCatalog(store: string, from: string, timeoutMs = LIST_TIMEOUT_MS): ScopeCatalog | undefined {
  const catalog = catalogOf(from, timeoutMs);
  if (!catalog) return undefined;
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(store, CATALOG), `${JSON.stringify(catalog)}\n`, 0o600);
  return catalog;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** A store's catalog; none when it has none, or one this code cannot read. */
export function readCatalog(store: string): ScopeCatalog | undefined {
  try {
    const value = JSON.parse(readFileSync(join(store, CATALOG), "utf8")) as Partial<ScopeCatalog>;
    const { built, checkout, scopes, waiting } = value;
    if (typeof built !== "number" || typeof checkout !== "string") return undefined;
    if (!isStringList(scopes) || !scopes.includes("") || !isStringList(waiting)) return undefined;
    return { built, checkout, scopes, waiting };
  } catch {
    return undefined;
  }
}

/** Whether writing a file of this name can change the catalog: a manifest, workspace or build-system root file. */
function shapesScopes(name: string): boolean {
  return (
    PLAIN_MANIFESTS.has(name) ||
    MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    name in CONTENT_MANIFESTS ||
    WORKSPACE_FILES.has(name) ||
    name === NX_PROJECT ||
    name === NX_ROOT ||
    BUILD_SYSTEM_ROOTS.includes(name)
  );
}

/**
 * A4 §2: whether files written (relative to their repo's top) rebuild the catalog: a manifest, workspace or
 * build-system root file, the override, or a file in a waiting directory (see the header). Without a catalog, none:
 * the turn's end builds it, off the agent's path, with no time limit to fail on a large repo.
 */
export function rebuildsCatalog(catalog: ScopeCatalog | undefined, written: readonly string[]): boolean {
  if (!catalog) return false;
  return written.some(
    (rel) =>
      rel === SCOPES_OVERRIDE ||
      shapesScopes(basename(rel)) ||
      catalog.waiting.some((dir) => rel.startsWith(`${dir}/`)),
  );
}

/**
 * The idle sleep's rebuild (D34): from the checkout the store's catalog was built from, while that checkout is still
 * this store's repo. A store with no catalog yet waits for a turn's end, which knows where its repo is.
 */
export function rebuildRecorded(store: string): ScopeCatalog | undefined {
  const recorded = readCatalog(store);
  if (!recorded || !existsSync(recorded.checkout)) return undefined;
  const place = gitPlace(recorded.checkout);
  if (!place || repoKeyOf(place.common) !== basename(store)) return undefined;
  return buildCatalog(store, recorded.checkout);
}
