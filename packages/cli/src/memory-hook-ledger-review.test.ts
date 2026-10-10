/**
 * P1.1 review round 1 probes (place in packages/cli/src/). A compaction's epoch must reach every ledger the window
 * has (EXECUTION X7, built in P0.8), and since P1.1 a ledger the window has may be only its snapshot: a Stop folds
 * `delivery.log` away into `delivery.json`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../../src/memory-ledger";
import { LIVE_LEDGER } from "../../../src/memory-window";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-review";
const RULE = "we use pnpm in this repo, never npm";
const CUE = "install the dependencies with npm";
const NOW = Date.parse("2026-10-10T12:00:00Z");

let dir = "";
const ENV_KEYS = [
  "EDEN_MEMORY_DIR",
  "EDEN_HOME",
  "EDEN_MEMORY",
  "EDEN_NOW",
  "EDEN_FLAG_DELIVER_SUBMIT",
  "EDEN_FLAG_DELIVER_SESSION_START",
] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-ledger-review-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
  delete process.env.EDEN_FLAG_DELIVER_SESSION_START;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

const win = () => join(dir, "memory", "windows", SESSION);

function submit(prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt, ...extra });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

function stopSleep(): void {
  memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION, last_assistant_message: "Done." }, "stop-sleep");
}

function compact(): void {
  memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "compact" });
}

function lastSubmitEvent(): Record<string, unknown> {
  const events = join(dir, "memory", "hook.log.d");
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .findLast((event) => event.ev === "UserPromptSubmit")!;
}

describe("P1.1 review: a compaction re-arms a folded ledger", () => {
  test("every point off: the compaction's epoch reaches the live snapshot, so turning on re-delivers", () => {
    submit(RULE);
    expect(submit(CUE, { prompt_id: "p-1" })).toContain(RULE);
    stopSleep();
    expect(existsSync(join(win(), "delivery.json"))).toBe(true);
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "off";
    process.env.EDEN_FLAG_DELIVER_SESSION_START = "off";
    compact();
    expect(readLedger(win(), LIVE_LEDGER).epoch).toBe(1);
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "on";
    process.env.EDEN_FLAG_DELIVER_SESSION_START = "on";
    expect(submit(CUE, { prompt_id: "p-2" })).toContain(RULE);
  });

  test("on → shadow: the shadow point does not count a pre-compaction live delivery as still held", () => {
    submit(RULE);
    expect(submit(CUE, { prompt_id: "p-1" })).toContain(RULE);
    stopSleep();
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "shadow";
    process.env.EDEN_FLAG_DELIVER_SESSION_START = "shadow";
    compact();
    expect(readLedger(win(), LIVE_LEDGER).epoch).toBe(1);
    submit(CUE, { prompt_id: "p-2" });
    const event = lastSubmitEvent();
    expect((event.drops as Record<string, number> | undefined)?.refractory ?? 0).toBe(0);
    expect((event.cids as string[] | undefined)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("P1.1 review: an Updated item is given once while it is still in the window", () => {
  test("after the switch's Updated item, the same cue again gets no second Updated item for the same change", () => {
    submit("Our auth provider is Auth0.");
    expect(submit("which auth provider do we use?", { prompt_id: "p-q1" })).toContain("Auth0");
    // Two sentences: the legacy store keeps the whole prompt as a row beside its sentence rows (D26's note).
    submit("We switched auth from Auth0 to Clerk. Keep the old Auth0 tenant until Friday.", { prompt_id: "p-switch" });
    submit("format the code", { prompt_id: "p-f1" });
    submit("run the linter", { prompt_id: "p-f2" });
    const first = submit("which auth provider do we use?", { prompt_id: "p-q2" });
    expect(first).toMatch(/\n- Updated: [^\n]*Clerk/);
    submit("format the code again", { prompt_id: "p-f3" });
    submit("run the linter again", { prompt_id: "p-f4" });
    const again = submit("which auth provider do we use?", { prompt_id: "p-q3" });
    expect(again ?? "").not.toMatch(/Updated:[^\n]*switched auth from Auth0 to Clerk/);
  });
});
