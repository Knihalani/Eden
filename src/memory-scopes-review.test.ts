/**
 * P3.1 code review round 2's probes, kept as regression tests: the regular-file reader, the override through it,
 * links inside the checkout, a checkout reached through a link, and the waiting rule's edges.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogOf, rebuildsCatalog } from "./memory-scopes";

let dir = "";
let top = "";

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function put(base: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text);
  }
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-p31-r2-")));
  top = join(dir, "repo");
  put(top, { "package.json": JSON.stringify({ name: "r" }), "packages/a/package.json": JSON.stringify({ name: "a" }) });
  put(top, { "packages/a/i.js": "" });
  git(top, "init", "-q", "-b", "main");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the reader", () => {
  test("an override linked to /dev/zero is not read and does not hang", () => {
    mkdirSync(join(top, ".eden"));
    symlinkSync("/dev/zero", join(top, ".eden/scopes"));
    const started = performance.now();
    expect(catalogOf(top)!.scopes).toEqual(["", "packages/a"]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a manifest linked to another file inside the checkout is read", () => {
    put(top, { "shared/pkg.json": JSON.stringify({ name: "b" }), "packages/b/i.js": "" });
    symlinkSync(join(top, "shared/pkg.json"), join(top, "packages/b/package.json"));
    expect(catalogOf(top)!.scopes).toContain("packages/b");
  });

  test("a manifest linked outside the checkout is not read", () => {
    put(dir, { "outside.json": JSON.stringify({ name: "o" }) });
    put(top, { "packages/o/i.js": "" });
    symlinkSync(join(dir, "outside.json"), join(top, "packages/o/package.json"));
    expect(catalogOf(top)!.scopes).not.toContain("packages/o");
  });

  test("a checkout reached through a link still reads its manifests", () => {
    symlinkSync(top, join(dir, "via"));
    expect(catalogOf(join(dir, "via"))!.scopes).toEqual(["", "packages/a"]);
  });
});

describe("waiting edges", () => {
  const catalog = { built: 0, checkout: "/x", scopes: ["", "tools/a"], waiting: ["tools", "tools/a/deep"] };
  test("a waiting folder inside a scope owns its files; its parent scope's other files do not count", () => {
    expect(rebuildsCatalog(catalog, ["tools/a/deep/x.ts"])).toBe(true);
    expect(rebuildsCatalog(catalog, ["tools/a/y.ts"])).toBe(false);
    expect(rebuildsCatalog(catalog, ["tools/z.ts"])).toBe(true);
    expect(rebuildsCatalog(catalog, ["toolsx/z.ts"])).toBe(false);
  });
});
