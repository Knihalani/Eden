/**
 * D8's miner (P3.4): the slot values a folder's own files state, with the files that state them, read narrowly (two
 * values of one slot state none; a version is exact or an `x` range; a file is read only when it is a small regular
 * file), and the words a mined fact is stored in, which the slot table reads back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exactVersion, minedText, presentFile, readFolders, type MinedFact } from "./memory-repo-facts";
import { slotsIn } from "./memory-slots";

let top = "";

beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), "eden-repo-facts-"));
});

afterEach(() => {
  rmSync(top, { recursive: true, force: true });
});

function files(tree: Record<string, string>): void {
  for (const [path, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(top, path)), { recursive: true });
    writeFileSync(join(top, path), text);
  }
}

const mineFolder = (at: string, scope: string) => readFolders(at, [scope]).facts;
const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: "app", ...fields });
const bySlot = (facts: readonly MinedFact[]) =>
  Object.fromEntries(facts.map((fact) => [fact.slot, [fact.value, fact.files.join(" ")]]));

describe("the package manager", () => {
  test("a lockfile states it, cited by the lockfile", () => {
    files({ "package.json": pkg({}), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    expect(bySlot(mineFolder(top, ""))["pkg.manager"]).toEqual(["pnpm", "pnpm-lock.yaml"]);
  });

  test("package.json's packageManager agreeing with the lockfile cites both", () => {
    files({ "package.json": pkg({ packageManager: "pnpm@9.1.0" }), "pnpm-lock.yaml": "" });
    expect(bySlot(mineFolder(top, ""))["pkg.manager"]).toEqual(["pnpm", "pnpm-lock.yaml package.json"]);
  });

  test("two managers' lockfiles, or a lockfile against packageManager, state none", () => {
    files({ "package.json": pkg({}), "package-lock.json": "{}", "yarn.lock": "" });
    expect(bySlot(mineFolder(top, ""))["pkg.manager"]).toBeUndefined();
    rmSync(join(top, "yarn.lock"));
    writeFileSync(join(top, "package.json"), pkg({ packageManager: "yarn@4.0.0" }));
    expect(bySlot(mineFolder(top, ""))["pkg.manager"]).toBeUndefined();
  });

  test("a folder with no lockfile states none (the root's value holds there)", () => {
    files({ "apps/web/package.json": pkg({ dependencies: { next: "15.0.0" } }), "package-lock.json": "{}" });
    expect(bySlot(mineFolder(top, "apps/web"))["pkg.manager"]).toBeUndefined();
    expect(bySlot(mineFolder(top, ""))["pkg.manager"]).toEqual(["npm", "package-lock.json"]);
  });
});

describe("the node version", () => {
  test(".nvmrc states it exactly; an engines bound states nothing", () => {
    files({ ".nvmrc": "v20.11.1\n", "package.json": pkg({ engines: { node: ">=18" } }) });
    expect(bySlot(mineFolder(top, ""))["node.version"]).toEqual(["20.11.1", ".nvmrc"]);
    rmSync(join(top, ".nvmrc"));
    expect(bySlot(mineFolder(top, ""))["node.version"]).toBeUndefined();
  });

  test("an x range in engines counts; an .nvmrc alias states nothing, whatever engines says", () => {
    files({ "package.json": pkg({ engines: { node: "20.x" } }) });
    expect(bySlot(mineFolder(top, ""))["node.version"]).toEqual(["20", "package.json"]);
    files({ ".nvmrc": "lts/iron\n" });
    expect(bySlot(mineFolder(top, ""))["node.version"]).toBeUndefined();
  });

  test("exactVersion", () => {
    expect(["20", "v20", "20.x", "20.11.1", " 22 "].map(exactVersion)).toEqual(["20", "20", "20", "20.11.1", "22"]);
    expect([">=18", "^20.1.0", "lts/*", "node", "20 || 22"].map(exactVersion)).toEqual(Array(5).fill(undefined));
  });
});

describe("package.json's dependencies", () => {
  test("a meta-framework is the framework, not what it builds on", () => {
    files({ "package.json": pkg({ dependencies: { next: "15", react: "19", "react-dom": "19" } }) });
    expect(bySlot(mineFolder(top, "")).framework).toEqual(["next.js", "package.json"]);
  });

  test("two frameworks state none; one alone states it", () => {
    files({ "package.json": pkg({ dependencies: { express: "4", fastify: "5" } }) });
    expect(bySlot(mineFolder(top, "")).framework).toBeUndefined();
    files({ "package.json": pkg({ dependencies: { react: "19" } }) });
    expect(bySlot(mineFolder(top, "")).framework).toEqual(["react", "package.json"]);
  });

  test("the test runner: the test script first, then one unit runner, then one end-to-end runner", () => {
    const deps = { devDependencies: { jest: "29", vitest: "2", "@playwright/test": "1" } };
    files({ "package.json": pkg({ ...deps, scripts: { test: "tsc --noEmit && vitest run" } }) });
    expect(bySlot(mineFolder(top, ""))["test.runner"]).toEqual(["vitest", "package.json"]);
    files({ "package.json": pkg(deps) });
    expect(bySlot(mineFolder(top, ""))["test.runner"]).toBeUndefined();
    files({ "package.json": pkg({ devDependencies: { vitest: "2", "@playwright/test": "1" } }) });
    expect(bySlot(mineFolder(top, ""))["test.runner"]).toEqual(["vitest", "package.json"]);
    files({ "package.json": pkg({ devDependencies: { "@playwright/test": "1" } }) });
    expect(bySlot(mineFolder(top, ""))["test.runner"]).toEqual(["playwright", "package.json"]);
    files({ "package.json": pkg({ scripts: { test: "bun test" } }) });
    expect(bySlot(mineFolder(top, ""))["test.runner"]).toEqual(["bun test", "package.json"]);
  });

  test("auth, database, ORM, formatter and linter SDKs", () => {
    const dependencies = { "@clerk/nextjs": "5", pg: "8", "drizzle-orm": "0.30" };
    const devDependencies = { prettier: "3", eslint: "9" };
    files({ "apps/web/package.json": pkg({ dependencies, devDependencies }) });
    expect(bySlot(mineFolder(top, "apps/web"))).toMatchObject({
      "auth.provider": ["clerk", "apps/web/package.json"],
      "db.engine": ["postgres", "apps/web/package.json"],
      orm: ["drizzle", "apps/web/package.json"],
      formatter: ["prettier", "apps/web/package.json"],
      linter: ["eslint", "apps/web/package.json"],
    });
  });

  test("biome with eslint leaves the linter open, and is still the formatter", () => {
    files({ "package.json": pkg({ devDependencies: { "@biomejs/biome": "1", eslint: "9" } }) });
    const facts = bySlot(mineFolder(top, ""));
    expect(facts.linter).toBeUndefined();
    expect(facts.formatter).toEqual(["biome", "package.json"]);
  });

  test("a package.json that is not JSON states nothing of its dependencies", () => {
    files({ "package.json": "{ not json", "package-lock.json": "{}" });
    expect(Object.keys(bySlot(mineFolder(top, "")))).toEqual(["pkg.manager"]);
  });
});

describe("CI, deploy targets, Python and Rust", () => {
  test("GitHub Actions by its workflow files, at the repo's top only", () => {
    files({ ".github/workflows/ci.yml": "on: push\n", ".github/workflows/release.yaml": "on: tag\n" });
    expect(bySlot(mineFolder(top, ""))["ci.system"]).toEqual([
      "github actions",
      ".github/workflows/ci.yml .github/workflows/release.yaml",
    ]);
    files({ "apps/web/.gitlab-ci.yml": "x" });
    expect(bySlot(mineFolder(top, "apps/web"))["ci.system"]).toBeUndefined();
  });

  test("two CI systems state none", () => {
    files({ ".github/workflows/ci.yml": "x", ".gitlab-ci.yml": "x" });
    expect(bySlot(mineFolder(top, ""))["ci.system"]).toBeUndefined();
  });

  test("a host's deploy file states the folder's deploy target", () => {
    files({ "apps/api/fly.toml": "app = 'api'\n" });
    expect(mineFolder(top, "apps/api")).toEqual([
      { scope: "apps/api", slot: "deploy.target", value: "fly.io", files: ["apps/api/fly.toml"] },
    ]);
  });

  test("pyproject's framework, pytest and ORM; .python-version's version", () => {
    files({
      "pyproject.toml": [
        "[project]",
        'dependencies = ["django>=5", "sqlalchemy[asyncio]"]',
        "[tool.pytest.ini_options]",
        'addopts = "-q"',
      ].join("\n"),
      ".python-version": "3.12\n",
    });
    expect(bySlot(mineFolder(top, ""))).toMatchObject({
      framework: ["django", "pyproject.toml"],
      "test.runner": ["pytest", "pyproject.toml"],
      orm: ["sqlalchemy", "pyproject.toml"],
      "lang.version": ["3.12", ".python-version"],
    });
  });

  test("Poetry's dependency tables", () => {
    files({ "pyproject.toml": "[tool.poetry.dependencies]\npython = '^3.11'\nfastapi = '^0.110'\n" });
    expect(bySlot(mineFolder(top, "")).framework).toEqual(["fastapi", "pyproject.toml"]);
  });

  test("Rust's toolchain channel, else Cargo's rust-version; two languages' versions state none", () => {
    files({ "Cargo.toml": '[package]\nname = "x"\nrust-version = "1.75"\n' });
    expect(bySlot(mineFolder(top, ""))["lang.version"]).toEqual(["1.75", "Cargo.toml"]);
    files({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.79.0"\n' });
    expect(bySlot(mineFolder(top, ""))["lang.version"]).toEqual(["1.79.0", "rust-toolchain.toml"]);
    files({ ".python-version": "3.12\n" });
    expect(bySlot(mineFolder(top, ""))["lang.version"]).toBeUndefined();
  });

  test("a framework that package.json and pyproject give differently states none", () => {
    files({
      "package.json": pkg({ dependencies: { express: "4" } }),
      "pyproject.toml": '[project]\ndependencies = ["flask"]\n',
    });
    expect(bySlot(mineFolder(top, "")).framework).toBeUndefined();
  });
});

describe("what is read", () => {
  test("a linked manifest or lockfile, and a manifest over 1 MB, state nothing", () => {
    files({ "real/package.json": pkg({ dependencies: { next: "15" } }), "real/pnpm-lock.yaml": "" });
    symlinkSync(join(top, "real", "package.json"), join(top, "package.json"));
    symlinkSync(join(top, "real", "pnpm-lock.yaml"), join(top, "pnpm-lock.yaml"));
    expect(mineFolder(top, "")).toEqual([]);
    files({ "big/package.json": pkg({ dependencies: { next: "15" }, pad: "x".repeat(1024 * 1024) }) });
    expect(mineFolder(top, "big")).toEqual([]);
  });

  test("readFolders reads every folder it is given, each fact at its folder, and names the slots it found torn", () => {
    files({
      "package-lock.json": "{}",
      "apps/web/package.json": pkg({ dependencies: { "@auth0/nextjs-auth0": "3" } }),
      "packages/cli/package.json": pkg({}),
    });
    files({ "packages/cli/package.json": pkg({ devDependencies: { jest: "29", vitest: "2" } }), "yarn.lock": "" });
    const reading = readFolders(top, ["", "apps/web", "packages/cli"]);
    expect(reading.top).toBe(top);
    expect(reading.facts.map((fact) => `${fact.scope}|${fact.slot}=${fact.value}`)).toEqual([
      "apps/web|auth.provider=auth0",
    ]);
    expect(reading.torn).toEqual([
      { scope: "", slot: "pkg.manager" },
      { scope: "packages/cli", slot: "test.runner" },
    ]);
  });
});

describe("presentFile", () => {
  test("a citation's file is there to read only as a regular file of the checkout", () => {
    files({ "apps/web/package.json": "{}" });
    symlinkSync(join(top, "apps", "web", "package.json"), join(top, "linked.json"));
    expect(presentFile(top, "apps/web/package.json")).toBe(true);
    expect(presentFile(top, "linked.json")).toBe(false);
    expect(presentFile(top, "package-lock.json")).toBe(false);
  });
});

describe("minedText", () => {
  test("reads as the slot table reads a statement back, at the fact's folder", () => {
    const texts = [
      minedText({ scope: "", slot: "pkg.manager", value: "pnpm", files: ["pnpm-lock.yaml"] }),
      minedText({ scope: "apps/web", slot: "auth.provider", value: "clerk", files: ["apps/web/package.json"] }),
      minedText({ scope: "", slot: "lang.version", value: "3.12", files: [".python-version"] }),
      minedText({ scope: "", slot: "ci.system", value: "github actions", files: [".github/workflows/ci.yml"] }),
    ];
    expect(texts).toEqual([
      "The package manager is pnpm",
      "In apps/web the auth provider is clerk",
      "The Python version is 3.12",
      "The CI is github actions",
    ]);
    expect(texts.map((text) => slotsIn(text).map((s) => `${s.slot}=${s.value}`))).toEqual([
      ["pkg.manager=pnpm"],
      ["auth.provider=clerk"],
      ["lang.version=3.12"],
      ["ci.system=github actions"],
    ]);
  });
});
