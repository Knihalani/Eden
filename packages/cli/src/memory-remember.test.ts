/**
 * `eden memory remember` (D11's command; the entry point the `policy-trigger`, `cuebench-code`, `alias-batch` and
 * scale arms plant through): each statement one row in the user's own words, in its repo's store (D1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRows } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";

const CLI = join(import.meta.dir, "cli.ts");
let dir = "";
let repoA = "";
let repoB = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-remember-"));
  for (const name of ["a", "b"]) {
    mkdirSync(join(dir, name));
    execFileSync("git", ["init", "-q"], { cwd: join(dir, name) });
  }
  [repoA, repoB] = [join(dir, "a"), join(dir, "b")];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function remember(args: string[], input = "", env: Record<string, string> = {}) {
  const run = spawnSync("bun", [CLI, "memory", "remember", ...args], {
    cwd: repoA,
    input,
    encoding: "utf8",
    env: { ...process.env, EDEN_MEMORY_DIR: join(dir, "memory"), EDEN_HOME: join(dir, "home"), ...env },
  });
  return { code: run.status, out: run.stdout.trim() };
}

const rowsOf = (repo: string) => storeRows(join(storeFor(join(dir, "memory"), repo), "memories.jsonl"));

describe("eden memory remember", () => {
  test("--jsonl - stores each statement as a typed row in its cwd's repo, and counts them", () => {
    const lines = [
      { text: "Never merge pull requests yourself.", cwd: repoA },
      { text: "We use pnpm.", kind: "fact", cwd: repoB, scope: "apps/web" },
      { text: "Explain things plainly.", kind: "preference" },
      { text: "" },
      "not json",
    ];
    const input = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
    const { code, out } = remember(["--jsonl", "-"], input);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ remembered: 3 });
    const a = rowsOf(repoA);
    expect(a.map((row) => row.text)).toEqual(["Never merge pull requests yourself.", "Explain things plainly."]);
    expect(a[0]).toMatchObject({ kind: "constraint", rules: [{ k: "integrate|neg|*" }] });
    expect(a[1]!.kind).toBe("preference");
    expect(a.every((row) => row.tags?.includes("src:user"))).toBe(true);
    expect(rowsOf(repoB).map((row) => row.text)).toEqual(["We use pnpm."]);
  });

  test("a single statement from the command line", () => {
    expect(remember(["Never", "force-push", "to", "main."]).out).toBe("remembered: 1");
    expect(rowsOf(repoA)[0]).toMatchObject({ text: "Never force-push to main.", kind: "constraint" });
  });

  test("stores nothing when memory is off", () => {
    expect(JSON.parse(remember(["--jsonl", "-"], '{"text": "We use pnpm."}', { EDEN_MEMORY: "off" }).out)).toEqual({
      remembered: 0,
    });
    expect(rowsOf(repoA)).toEqual([]);
  });

  test("--global keeps a rule for every repo (D11), in the user-global store only", () => {
    expect(remember(["--global", "Never", "force-push."]).out).toBe("remembered: 1");
    const kept = storeRows(join(dir, "memory", "_user", "policies.jsonl"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ text: "Never force-push.", kind: "constraint" });
    expect(kept[0]!.rules?.map((rule) => rule.k)).toEqual(["history-rewrite|neg|*"]);
    expect(kept[0]!.tags).toContain("all-projects");
    expect(rowsOf(repoA)).toEqual([]);
  });

  test("--global keeps no fact and no intent: user-global holds policies only (D11)", () => {
    const input = ['{"text": "We use pnpm."}', '{"text": "Don\'t open the PR yet."}'].join("\n");
    expect(JSON.parse(remember(["--global", "--jsonl", "-"], input).out)).toEqual({ remembered: 0 });
    expect(storeRows(join(dir, "memory", "_user", "policies.jsonl"))).toEqual([]);
  });
});
