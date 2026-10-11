/**
 * P2.1 review round 1: the reviewer's probes, kept as regression tests. Each states the behaviour D9 / A4 §3.1 / L8
 * asks for (findings 2–6, 8, 9, 11, 13).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, superseded } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { counteredKeys } from "../../../src/memory-validity";
import { rulesIn, ruleKey } from "../../../src/memory-policy";
import { memoryHookResponse } from "./memory-hook";

const NOW = Date.parse("2026-10-11T12:00:00Z");
let dir = "";
let project = "";
const KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-p21-probe-"));
  project = join(dir, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k]);
});
const hook = (fields: Record<string, unknown>, session = "s1") =>
  memoryHookResponse({ session_id: session, cwd: project, ...fields });
let n = 0;
function submit(prompt: string): void {
  hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: "p" + n++ });
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
}
const start = (s: string) =>
  ((hook({ hook_event_name: "SessionStart", source: "startup" }, s)?.hookSpecificOutput as any)?.additionalContext ??
    "") as string;
const rows = () => openMemory({ dir: storeFor(process.env.EDEN_MEMORY_DIR!, project), perRepo: true }).memories();
const row = (words: string) => rows().find((r) => r.text.includes(words))!;
const keys = (t: string) => rulesIn(t).map((r) => r.kind + ":" + ruleKey(r));

describe("P2.1 review probes", () => {
  test("D9: a qualifier in one clause does not make another clause's explicit never an intent", () => {
    expect(keys("Never force-push, and don't open the PR yet.")).toContain("policy:history-rewrite|neg|*");
  });

  test("D9 fix 1: a precondition clause with any finite verb keeps a standing policy", () => {
    expect(keys("Always merge after CI passes.")).toEqual(["policy:integrate|pos|*"]);
    expect(keys("Never merge before CI finishes.")).toEqual(["policy:integrate|neg|*"]);
  });

  test("L8: a positive rule whose class word is only in its precondition does not supersede a prohibition", () => {
    submit("Don't push.");
    submit("Always run the tests before you push.");
    expect(superseded(row("Don't push"))).toBe(false);
    expect(start("s-next")).toContain("Don't push");
  });

  test("fix 4: .env.example is not .env; a rule about it does not supersede the .env rule", () => {
    submit("Never touch the .env file.");
    submit("Always update .env.example when you add a variable.");
    expect(superseded(row("Never touch the .env"))).toBe(false);
    expect(start("s-next")).toContain("Never touch the .env file");
  });

  test("an explicit never with a qualifier in another clause stays pinned and does not expire", () => {
    submit("Never force-push, and don't open the PR yet.");
    const r = row("Never force-push");
    expect(r.validUntil).toBeUndefined();
    expect(r.tags ?? []).toContain("pin");
  });

  test("objects: a relative clause ends the object; versions are not truncated", () => {
    expect(keys("don't amend commits that are already pushed")).toEqual(["policy:history-rewrite|neg|commit"]);
    expect(keys("don't push the v1.2 tag")).not.toEqual(keys("don't push the v1.3 tag"));
  });

  test("fix 2: 'I want you to never …' instructs", () => {
    expect(keys("I want you to never push to main.")).toEqual(["policy:push-upstream|neg|main"]);
  });
  test("L8: an exception in the same prompt does not supersede the rule it qualifies", () => {
    submit("Don't merge PRs. Always merge PRs from dependabot.");
    expect(superseded(row("Don't merge PRs"))).toBe(false);
    expect(start("s-next")).toContain("Don't merge PRs");
  });

  test("D9: an expired intent is not briefed through a session gist", () => {
    const stop = (s: string) => {
      memoryHookResponse(
        { session_id: s, cwd: project, hook_event_name: "Stop", last_assistant_message: "OK." },
        "stop-sleep",
      );
      process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
    };
    submit("Never merge PRs yourself. Don't open the PR yet.");
    stop("s-one");
    submit("Never merge PRs yourself. Don't open the PR yet.");
    stop("s1");
    process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 8 * 86_400_000);
    expect(start("s-week-later")).not.toContain("open the PR yet");
  });

  test("A4 §3.1: a revocation reaches every class the extractor keys (review, protected-path)", () => {
    expect(counteredKeys("You can open the PR now.")).toContain("review|neg|*");
    expect(counteredKeys("You can edit the .env file now.")).toContain("protected-path|neg|.env");
  });
});
