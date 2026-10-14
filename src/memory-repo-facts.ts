/**
 * D8's repo-fact mining (P3.4): the D7 slots a repo's own files state, each with the files that state it (its
 * citation, D31). A miner reads, in each folder of the scope catalog (P3.1), only the files D8 names:
 * - **Lockfiles** and `package.json`'s `packageManager` → `pkg.manager`;
 * - **`.nvmrc` / `.node-version`**, else `package.json`'s `engines.node` → `node.version`;
 * - **`package.json`'s dependencies** (and devDependencies) → `framework`, `test.runner` (its `test` script first),
 *   `auth.provider`, `db.engine`, `orm`, `formatter`, `linter`;
 * - **CI files** at the repo's top → `ci.system`; a host's deploy file → `deploy.target`;
 * - **`pyproject.toml`**, `.python-version`, `Cargo.toml`, `rust-toolchain(.toml)` → a Python project's framework,
 *   test runner and ORM, and the Python or Rust version (`lang.version`).
 *
 * Read narrowly, as a false slot supersedes a true one (D7): a folder whose files give a slot two values (two lockfiles
 * of different managers, express and fastify) states none of it; a version is an exact one or an `x` range ("20",
 * "20.x", "v20.11.1"), never a bound (">=18"); a framework a meta-framework builds on is the meta-framework's (react
 * under next). Each file is read only when it is a regular file of at most 1 MB (a lockfile only needs to exist).
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slotLabel, type SlotId } from "./memory-slots";
import { jsonObject } from "./memory-scopes";

/** One slot value a folder's files state: the folder is its scope, the files (repo-relative, `/`) its citation. */
export interface MinedFact {
  scope: string;
  slot: SlotId;
  value: string;
  files: string[];
}

/** A file read bigger than this states nothing: a manifest is small, and a lockfile is never read. */
const READ_CAP = 1024 * 1024;

const LOCKFILES: Readonly<Record<string, string>> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

/** A dependency's name → the slot value it shows: an exact name, or a scope prefix ending in `/`. */
type DependencyMap = readonly (readonly [name: string, value: string])[];

const FRAMEWORKS: DependencyMap = [
  ["next", "next.js"],
  ["@remix-run/react", "remix"],
  ["@remix-run/node", "remix"],
  ["@sveltejs/kit", "sveltekit"],
  ["nuxt", "nuxt"],
  ["astro", "astro"],
  ["@nestjs/core", "nestjs"],
  ["@angular/core", "angular"],
  ["fastify", "fastify"],
  ["express", "express"],
  ["hono", "hono"],
  ["react", "react"],
  ["vue", "vue"],
  ["svelte", "svelte"],
];
/** What each meta-framework builds on: react under next is next's (see the header). */
const BUILDS_ON: Readonly<Record<string, readonly string[]>> = {
  "next.js": ["react"],
  remix: ["react"],
  sveltekit: ["svelte"],
  nuxt: ["vue"],
  astro: ["react", "vue", "svelte"],
  nestjs: ["express", "fastify"],
};
const UNIT_RUNNERS: DependencyMap = [
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["mocha", "mocha"],
  ["ava", "ava"],
  ["jasmine", "jasmine"],
];
/** End-to-end runners: a package's test runner only when it has no unit runner. */
const E2E_RUNNERS: DependencyMap = [
  ["@playwright/test", "playwright"],
  ["cypress", "cypress"],
];
/** A `test` script's command → its runner (`bun test` before `bun`'s other commands). */
const SCRIPT_RUNNERS: readonly (readonly [RegExp, string])[] = [
  [/^bun\s+test\b/, "bun test"],
  [/^(?:npx\s+)?vitest\b/, "vitest"],
  [/^(?:npx\s+)?jest\b/, "jest"],
  [/^(?:npx\s+)?mocha\b/, "mocha"],
  [/^(?:npx\s+)?ava\b/, "ava"],
  [/^(?:npx\s+)?jasmine\b/, "jasmine"],
  [/^(?:npx\s+)?playwright\s+test\b/, "playwright"],
  [/^(?:npx\s+)?cypress\s+run\b/, "cypress"],
  [/^(?:python\s+-m\s+)?pytest\b/, "pytest"],
];
const AUTH: DependencyMap = [
  ["@clerk/", "clerk"],
  ["@auth0/", "auth0"],
  ["next-auth", "nextauth"],
  ["@auth/core", "nextauth"],
  ["@supabase/auth-helpers-nextjs", "supabase auth"],
  ["@supabase/auth-helpers-react", "supabase auth"],
  ["lucia", "lucia"],
  ["better-auth", "better-auth"],
  ["@workos-inc/", "workos"],
  ["@kinde-oss/", "kinde"],
  ["stytch", "stytch"],
  ["@stytch/", "stytch"],
  ["keycloak-js", "keycloak"],
  ["@okta/", "okta"],
  ["amazon-cognito-identity-js", "cognito"],
];
const DATABASES: DependencyMap = [
  ["pg", "postgres"],
  ["postgres", "postgres"],
  ["@neondatabase/serverless", "postgres"],
  ["@vercel/postgres", "postgres"],
  ["mysql2", "mysql"],
  ["mysql", "mysql"],
  ["mariadb", "mariadb"],
  ["better-sqlite3", "sqlite"],
  ["sqlite3", "sqlite"],
  ["mongodb", "mongodb"],
  ["mongoose", "mongodb"],
];
const ORMS: DependencyMap = [
  ["drizzle-orm", "drizzle"],
  ["prisma", "prisma"],
  ["@prisma/client", "prisma"],
  ["typeorm", "typeorm"],
  ["sequelize", "sequelize"],
  ["kysely", "kysely"],
  ["@mikro-orm/core", "mikro-orm"],
];
const FORMATTERS: DependencyMap = [
  ["prettier", "prettier"],
  ["@biomejs/biome", "biome"],
  ["dprint", "dprint"],
];
const LINTERS: DependencyMap = [
  ["eslint", "eslint"],
  ["@biomejs/biome", "biome"],
  ["oxlint", "oxlint"],
  ["tslint", "tslint"],
];
const PYTHON_FRAMEWORKS: DependencyMap = [
  ["django", "django"],
  ["flask", "flask"],
  ["fastapi", "fastapi"],
];
const PYTHON_ORMS: DependencyMap = [["sqlalchemy", "sqlalchemy"]];

/** CI systems by the files that configure them, at the repo's top; GitHub Actions by its workflows folder. */
const CI_FILES: Readonly<Record<string, string>> = {
  ".circleci/config.yml": "circleci",
  ".gitlab-ci.yml": "gitlab ci",
  ".buildkite/pipeline.yml": "buildkite",
  Jenkinsfile: "jenkins",
  ".travis.yml": "travis ci",
};
const WORKFLOWS = ".github/workflows";
const DEPLOY_FILES: Readonly<Record<string, string>> = {
  "vercel.json": "vercel",
  "fly.toml": "fly.io",
  "netlify.toml": "netlify",
  "render.yaml": "render",
  "railway.json": "railway",
  "railway.toml": "railway",
};

/** An exact version or an `x` range ("20", "v20.11.1", "20.x"), as D7's version class holds it; else undefined. */
export function exactVersion(raw: string): string | undefined {
  const match = /^v?(\d+(?:\.\d+){0,2})(?:\.x)?$/i.exec(raw.trim());
  return match?.[1];
}

/** Where a folder's files are read from: the checkout and the folder, relative to it with `/` ("" is the top). */
interface Folder {
  top: string;
  scope: string;
}

function relPath(folder: Folder, name: string): string {
  return folder.scope ? `${folder.scope}/${name}` : name;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** A regular file's text, when it has at most `READ_CAP` bytes (see the header). */
function readSmall(folder: Folder, name: string): string | undefined {
  try {
    const path = join(folder.top, relPath(folder, name));
    const stat = lstatSync(path);
    return stat.isFile() && stat.size <= READ_CAP ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function hasFile(folder: Folder, name: string): boolean {
  return isRegularFile(join(folder.top, relPath(folder, name)));
}

/** The values a dependency map gives a set of dependency names, each once. */
function valuesOf(names: readonly string[], map: DependencyMap): string[] {
  const found = new Set<string>();
  for (const [name, value] of map)
    if (names.some((dependency) => (name.endsWith("/") ? dependency.startsWith(name) : dependency === name)))
      found.add(value);
  return [...found];
}

/**
 * What a folder's file gives a slot: one value, the values it is torn between (several: it states none, see the
 * header), or none; with the files that say so.
 */
type Add = (slot: SlotId, values: string | readonly string[] | undefined, files: string[]) => void;

function stringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A folder's facts from its `package.json`, and from the files beside it for the slots they share. */
function nodeFacts(folder: Folder, add: Add): void {
  const text = readSmall(folder, "package.json");
  const pkg = text === undefined ? undefined : jsonObject(text);
  const manifest = pkg ? [relPath(folder, "package.json")] : [];
  const locks = Object.keys(LOCKFILES).filter((name) => hasFile(folder, name));
  const declared = typeof pkg?.packageManager === "string" ? /^([a-z]+)@/.exec(pkg.packageManager)?.[1] : undefined;
  const known = declared && Object.values(LOCKFILES).includes(declared) ? [declared] : [];
  const managers = [...new Set([...locks.map((name) => LOCKFILES[name]!), ...known])];
  add("pkg.manager", managers, [...locks.map((name) => relPath(folder, name)), ...(known.length ? manifest : [])]);
  const versionFile = [".nvmrc", ".node-version"].find((name) => hasFile(folder, name));
  const pinned = versionFile ? exactVersion(readSmall(folder, versionFile)?.split("\n")[0] ?? "") : undefined;
  if (versionFile) add("node.version", pinned, [relPath(folder, versionFile)]);
  else {
    const engine = stringRecord(pkg?.engines).node;
    add("node.version", typeof engine === "string" ? exactVersion(engine) : undefined, manifest);
  }
  if (!pkg) return;
  const names = [...Object.keys(stringRecord(pkg.dependencies)), ...Object.keys(stringRecord(pkg.devDependencies))];
  const frameworks = valuesOf(names, FRAMEWORKS);
  const built = frameworks.flatMap((value) => BUILDS_ON[value] ?? []);
  add(
    "framework",
    frameworks.filter((value) => !built.includes(value)),
    manifest,
  );
  add("test.runner", testRunners(pkg, names), manifest);
  add("auth.provider", valuesOf(names, AUTH), manifest);
  add("db.engine", valuesOf(names, DATABASES), manifest);
  add("orm", valuesOf(names, ORMS), manifest);
  add("formatter", valuesOf(names, FORMATTERS), manifest);
  add("linter", valuesOf(names, LINTERS), manifest);
}

/** A package's test runners: its `test` script's command, else its unit runners, else its end-to-end runners. */
function testRunners(pkg: Record<string, unknown>, names: readonly string[]): string[] {
  const script = stringRecord(pkg.scripts).test;
  if (typeof script === "string")
    for (const command of script.split(/&&|;|\|\|/)) {
      const runner = SCRIPT_RUNNERS.find(([pattern]) => pattern.test(command.trim()))?.[1];
      if (runner) return [runner];
    }
  const units = valuesOf(names, UNIT_RUNNERS);
  return units.length ? units : valuesOf(names, E2E_RUNNERS);
}

/** The dependency names a `pyproject.toml` lists: PEP 621's arrays and Poetry's tables. */
function pythonDependencies(text: string): string[] {
  const names = new Set<string>();
  let section = "";
  for (const line of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (/dependencies$/.test(section) && section.startsWith("tool.poetry")) {
      const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
      if (key && key.toLowerCase() !== "python") names.add(key.toLowerCase());
    }
  }
  for (const array of text.matchAll(/^\s*(?:dependencies|dev|test)\s*=\s*\[([^\]]*)\]/gm))
    for (const quoted of array[1]!.matchAll(/["']\s*([A-Za-z0-9_.-]+)/g)) names.add(quoted[1]!.toLowerCase());
  return [...names];
}

/** A folder's facts from its Python and Rust files (D8's `pyproject`, `Cargo.toml`). */
function otherFacts(folder: Folder, add: Add): void {
  const pyproject = readSmall(folder, "pyproject.toml");
  const versions: { value: string; file: string }[] = [];
  if (pyproject !== undefined) {
    const file = [relPath(folder, "pyproject.toml")];
    const names = pythonDependencies(pyproject);
    add("framework", valuesOf(names, PYTHON_FRAMEWORKS), file);
    const pytest = names.includes("pytest") || /^\s*\[tool\.pytest\.ini_options\]/m.test(pyproject);
    add("test.runner", pytest ? "pytest" : undefined, file);
    add("orm", valuesOf(names, PYTHON_ORMS), file);
  }
  const python = exactVersion(readSmall(folder, ".python-version")?.split("\n")[0] ?? "");
  if (python) versions.push({ value: python, file: relPath(folder, ".python-version") });
  const rust = rustVersion(folder);
  if (rust) versions.push(rust);
  add(
    "lang.version",
    versions.map((version) => version.value),
    versions.map((version) => version.file),
  );
}

/** A Rust project's pinned version: `rust-toolchain(.toml)`'s channel, else `Cargo.toml`'s `rust-version`. */
function rustVersion(folder: Folder): { value: string; file: string } | undefined {
  for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
    const text = readSmall(folder, name);
    if (text === undefined) continue;
    const channel = /^\s*channel\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? text.split("\n")[0]!;
    const value = exactVersion(channel);
    return value ? { value, file: relPath(folder, name) } : undefined;
  }
  const cargo = readSmall(folder, "Cargo.toml");
  const declared = cargo === undefined ? undefined : /^\s*rust-version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  const value = declared ? exactVersion(declared) : undefined;
  return value ? { value, file: relPath(folder, "Cargo.toml") } : undefined;
}

/** The repo's CI system, from the files at its top. */
function ciFacts(folder: Folder, add: Add): void {
  const found = new Map<string, string[]>();
  for (const [file, system] of Object.entries(CI_FILES)) if (hasFile(folder, file)) found.set(system, [file]);
  const workflows = workflowFiles(folder);
  if (workflows.length) found.set("github actions", workflows);
  add("ci.system", [...found.keys()], [...found.values()].flat());
}

/** The workflow files of `.github/workflows`, sorted. */
function workflowFiles(folder: Folder): string[] {
  try {
    return readdirSync(join(folder.top, WORKFLOWS))
      .filter((name) => /\.ya?ml$/.test(name) && isRegularFile(join(folder.top, WORKFLOWS, name)))
      .sort()
      .map((name) => `${WORKFLOWS}/${name}`);
  } catch {
    return [];
  }
}

/** A folder's deploy target, from a host's own config file. */
function deployFacts(folder: Folder, add: Add): void {
  const found = Object.entries(DEPLOY_FILES).filter(([file]) => hasFile(folder, file));
  add(
    "deploy.target",
    [...new Set(found.map(([, value]) => value))],
    found.map(([file]) => relPath(folder, file)),
  );
}

/**
 * What some folders' files state (see the header), read from the checkout at `top`: the facts, and the slots a folder's
 * files are torn on (two values: none is stated, and nothing can be said of the value they last stated).
 */
export interface Reading {
  top: string;
  /** The folders read. */
  scopes: string[];
  facts: MinedFact[];
  torn: { scope: string; slot: SlotId }[];
}

/** Reads each folder (a catalog scope; the top's CI files only at the top). */
export function readFolders(top: string, scopes: readonly string[]): Reading {
  const reading: Reading = { top, scopes: [...scopes], facts: [], torn: [] };
  for (const scope of scopes) {
    const folder = { top, scope };
    const facts = new Map<SlotId, MinedFact>();
    const torn = new Set<SlotId>();
    const add: Add = (slot, values, files) => {
      const said = values === undefined ? [] : typeof values === "string" ? [values] : values;
      if (!said.length || !files.length || torn.has(slot)) return;
      const known = facts.get(slot);
      if (said.length > 1 || (known && known.value !== said[0])) {
        facts.delete(slot);
        torn.add(slot);
      } else if (known) known.files = [...new Set([...known.files, ...files])];
      else facts.set(slot, { scope, slot, value: said[0]!, files: [...new Set(files)] });
    };
    nodeFacts(folder, add);
    otherFacts(folder, add);
    deployFacts(folder, add);
    if (scope === "") ciFacts(folder, add);
    reading.facts.push(...facts.values());
    reading.torn.push(...[...torn].map((slot) => ({ scope, slot })));
  }
  return reading;
}

/** Whether a repo-relative file is a regular file of the checkout: a citation's file still there to read. */
export function presentFile(top: string, rel: string): boolean {
  return isRegularFile(join(top, ...rel.split("/")));
}

/** `lang.version`'s label by the file that pins it: one language's version, which D7's table keys as one slot. */
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  ".python-version": "Python version",
  "rust-toolchain.toml": "Rust version",
  "rust-toolchain": "Rust version",
  "Cargo.toml": "Rust version",
};

/**
 * How a mined fact reads, in the words the slot table reads back (as the session gist's, P3.3): "In apps/web the auth
 * provider is clerk", "The package manager is pnpm".
 */
export function minedText(fact: Pick<MinedFact, "scope" | "slot" | "value" | "files">): string {
  const file = fact.files[0] ?? "";
  const language = fact.slot === "lang.version" ? LANGUAGE_LABELS[file.slice(file.lastIndexOf("/") + 1)] : undefined;
  const label = language ?? slotLabel(fact.slot);
  return `${fact.scope ? `In ${fact.scope} the` : "The"} ${label} is ${fact.value}`;
}
