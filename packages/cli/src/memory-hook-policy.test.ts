/**
 * P2.1 at the hook (D9, A4 §3.1, L8): typed rules keep their keys through the Submit path, and a rule the user
 * superseded (the opposite polarity, or a revocation) is not briefed at SessionStart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-policy";
const NOW = Date.parse("2026-10-11T12:00:00Z");

let dir = "";
let project = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-policy-"));
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

function hook(fields: Record<string, unknown>, session = SESSION): Record<string, unknown> | null {
  return memoryHookResponse({ session_id: session, cwd: project, ...fields });
}

function submit(prompt: string, promptId: string): void {
  hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId });
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
}

function startPacket(session: string): string {
  const out = hook({ hook_event_name: "SessionStart", source: "startup" }, session);
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

const repoRows = () => openMemory({ dir: storeFor(process.env.EDEN_MEMORY_DIR!, project), perRepo: true }).memories();

describe("P2.1 at the hook", () => {
  test("a typed rule keeps its key through Submit", () => {
    submit("Push the fix to the PR, but don't merge it yourself.", "p1");
    const row = repoRows().find((r) => r.text.includes("merge it yourself"));
    expect(row?.rules).toEqual([{ k: "integrate|neg|*" }]);
  });

  test("SessionStart briefs the newer rule, not the one it superseded", () => {
    submit("Always squash when merging.", "p1");
    expect(startPacket("s-next")).toContain("Always squash when merging");
    submit("Never squash, keep every commit.", "p2");
    const packet = startPacket("s-later");
    expect(packet).toContain("Never squash");
    expect(packet).not.toContain("Always squash");
  });
});
