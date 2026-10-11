/**
 * P2.2 at the hook (A4 §5.1 steps 4b–9): a class the typed prompt fires delivers its rule as "Rule you set: …", and
 * a later prompt of the class in the same window does not repeat it (the ledger's refractory, A4 §4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-triggers";
const NOW = Date.parse("2026-10-11T12:00:00Z");

let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-triggers-"));
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
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

function submit(prompt: string, promptId: string, session = SESSION): string {
  const out = memoryHookResponse({
    session_id: session,
    cwd: project,
    hook_event_name: "UserPromptSubmit",
    prompt,
    prompt_id: promptId,
  });
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

describe("P2.2 at the hook", () => {
  test("a fired class delivers the rule the user set in an earlier session, once per window", () => {
    submit("Never merge PRs yourself.", "p1", "s-earlier");
    const packet = submit("looks done, can you land it?", "p2");
    expect(packet).toContain("Rule you set: Never merge PRs yourself");
    expect(submit("ok, ship it then", "p3")).not.toContain("Never merge PRs yourself");
  });

  test("a prompt asking about the topic gets no rule", () => {
    submit("Never deploy to production on Fridays.", "p1", "s-earlier");
    expect(submit("where do the production deploy logs go on Fridays?", "p2")).not.toContain("Never deploy");
  });
});
