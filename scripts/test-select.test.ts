import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DATA_DIRS, touchedPackages, type Pkg } from "./test-select";

/** This repo's own workspace packages with their @eden/* dependencies, read as test-select.ts reads them. */
function repoPackages(): Pkg[] {
  const root = join(import.meta.dir, "..");
  const out: Pkg[] = [];
  for (const parent of ["packages", "examples"]) {
    for (const d of readdirSync(join(root, parent))) {
      const file = join(root, parent, d, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      out.push({ dir: `${parent}/${d}`, name: pkg.name, deps });
    }
  }
  return out;
}

const pkgs = [
  { dir: "packages/protocol", name: "@eden/protocol", deps: [] },
  { dir: "packages/engine", name: "@eden/engine", deps: ["@eden/protocol"] },
  { dir: "packages/server", name: "@eden/server", deps: ["@eden/engine"] },
];

describe("test:changed selection", () => {
  test("a checked-in profile under docs/profiles selects the server, whose test loads it (D104)", () => {
    expect(touchedPackages(["docs/profiles/fallback-asks.json"], pkgs)).toEqual(["packages/server"]);
    expect(DATA_DIRS["docs/profiles/"]).toBe("packages/server");
  });

  test("other docs and Markdown select nothing; package code selects its dependents; outside code selects all", () => {
    expect(touchedPackages(["docs/DECISIONS.md", "docs/research/x.json", "packages/engine/README.md"], pkgs)).toEqual(
      [],
    );
    expect(touchedPackages(["packages/engine/src/partner.ts"], pkgs)).toEqual(["packages/engine", "packages/server"]);
    expect(touchedPackages(["scripts/test.sh"], pkgs, () => {})).toBeNull();
    // Markdown stays skipped inside a data directory: the profiles' README is read by no test.
    expect(touchedPackages(["docs/profiles/README.md"], pkgs)).toEqual([]);
  });

  test("a change to the server's model wiring reruns the eval, which builds its live reader from it (D128)", () => {
    // eval imports modelRolesFromEnv and readerFailureLog from @eden/server; selection follows package.json only, so
    // the dependency must be declared there or test:changed skips eval's tests.
    const pkgs = repoPackages();
    for (const file of ["packages/server/src/models.ts", "packages/server/src/build.ts"]) {
      expect(touchedPackages([file], pkgs)).toContain("packages/eval");
    }
    // sim's lab drives the eval on Anthropic (eval-live.ts): an eval change reruns sim.
    expect(touchedPackages(["packages/eval/src/run.ts"], pkgs)).toContain("packages/sim");
  });

  test("every data directory maps to a workspace package", () => {
    for (const dir of Object.values(DATA_DIRS)) {
      expect(existsSync(join(import.meta.dir, "..", dir, "package.json"))).toBe(true);
    }
  });

  test("end to end: a typo in a profile, uncommitted, selects packages/server with --base HEAD", () => {
    // A throwaway repo, so the user's tree is never touched.
    const repo = mkdtempSync(join(tmpdir(), "test-select-"));
    const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q");
    for (const [path, body] of [
      ["packages/server/package.json", '{"name":"@eden/server"}'],
      ["packages/server/src/a.test.ts", ""],
      ["docs/profiles/fallback-asks.json", '{"fallbackAsks":true}'],
    ] as const) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    run("add", ".");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    writeFileSync(join(repo, "docs/profiles/fallback-asks.json"), '{"fallbakAsks":true}');
    const r = spawnSync("bun", [join(import.meta.dir, "test-select.ts"), "changed", "--base", "HEAD", "--dry"], {
      encoding: "utf8",
      env: { ...process.env, EDEN_TEST_SELECT_ROOT: repo },
    });
    expect(r.status).toBe(0);
    rmSync(repo, { recursive: true, force: true });
    expect(r.stdout).toContain("testing packages/server");
  });
});
