/**
 * P2.5 code review, round 1 (the reviewer's probes): prose with a slash is no place of the repo even where its first
 * word is a folder; an agent's name read with a doubled consonant or "-ator".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentClasses, taskPaths } from "./memory-spawn";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p25-spawn-probe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("taskPaths: prose with a slash, where its first word is a folder", () => {
  test("'and/or' is no place of the repo even when a folder named 'and' exists", () => {
    for (const folder of ["apps/web/app", "packages/cli/src", "src", "and"])
      mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# demo\n");
    expect(taskPaths("add apps/web/app/new.ts; and/or check docs/guide.md and/or", dir)).toEqual([
      "apps/web/app/new.ts",
    ]);
  });

  test("'client/server' prose in a repo with a client folder is no place", () => {
    mkdirSync(join(dir, "client"), { recursive: true });
    expect(taskPaths("explain the client/server split", dir)).toEqual([]);
  });
});

describe("agentClasses: common agent names", () => {
  test("a doubled consonant and -ator are read as verbs; the built-in types name no class", () => {
    const out = Object.fromEntries(
      [
        "code-reviewer",
        "reviewer",
        "pr-reviewer",
        "general-purpose",
        "Explore",
        "Plan",
        "fork",
        "deployer",
        "test-runner",
        "git-committer",
        "release-manager",
        "db-migrator",
        "statusline-setup",
      ].map((t) => [t, agentClasses(t)]),
    );
    expect(out["git-committer"]).toContain("commit");
    expect(out.deployer).toEqual(["deploy"]);
    expect(out.reviewer).toEqual(["review", "integrate"]);
    expect(out["general-purpose"]).toEqual([]);
    expect(out.Explore).toEqual([]);
    expect(out.Plan).toEqual([]);
  });
});
