/**
 * The store's rule index (A4 §1 `policies.jsonl`, `intents.jsonl`; A7 §5's lookup): written beside a repo store at
 * each persist, from the typed rule rows still in force, intents apart, and only when it changed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";
import { INTENTS_FILE, POLICIES_FILE, readRuleIndex } from "./memory-rule-index";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

function repoStore(perRepo = true) {
  const dir = mkdtempSync(join(tmpdir(), "eden-rule-index-"));
  dirs.push(dir);
  process.env.EDEN_NOW = String(T0);
  return { dir, mem: openMemory({ dir, perRepo, session: "s1" }) };
}

const typed = (content: string) => ({ role: "user", content, src: "user" as const });
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);

describe("the rule index", () => {
  test("typed rule rows only, policies and intents apart, each with its keys", () => {
    const { dir, mem } = repoStore();
    mem.observe([typed("Never force-push."), typed("Don't open the PR yet."), typed("The cache is Redis.")], {
      keepLiveIdentity: true,
    });
    mem.observe([{ role: "assistant", content: "Never merge PRs yourself.", src: "agent" as const }], {
      keepLiveIdentity: true,
    });
    expect(lines(join(dir, POLICIES_FILE)).map((line) => JSON.parse(line).rules)).toEqual([
      [{ k: "history-rewrite|neg|*", v: "force-push" }],
    ]);
    const intent = JSON.parse(lines(join(dir, INTENTS_FILE))[0]!);
    expect(intent.rules).toEqual([{ k: "review|neg|*", q: "yet" }]);
    expect(intent.validUntil).toBe(T0 + 7 * 86_400_000);
    expect(readRuleIndex(dir).map((row) => row.text)).toEqual(["Never force-push", "Don't open the PR yet"]);
  });

  test("a row superseded by the opposite rule leaves the index", () => {
    const { dir, mem } = repoStore();
    mem.observe([typed("Always squash when merging.")], { keepLiveIdentity: true });
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.observe([typed("Never squash.")], { keepLiveIdentity: true });
    expect(readRuleIndex(dir).map((row) => row.text)).toEqual(["Never squash"]);
  });

  test("rewritten only when it changes; a session store has none", () => {
    const { dir, mem } = repoStore();
    mem.observe([typed("Never force-push.")], { keepLiveIdentity: true });
    const before = statSync(join(dir, POLICIES_FILE)).mtimeMs;
    Bun.sleepSync(20);
    mem.observe([typed("The cache is Redis.")], { keepLiveIdentity: true });
    expect(statSync(join(dir, POLICIES_FILE)).mtimeMs).toBe(before);
    const session = repoStore(false);
    session.mem.observe([typed("Never force-push.")], { keepLiveIdentity: true });
    expect(existsSync(join(session.dir, POLICIES_FILE))).toBe(false);
  });
});
