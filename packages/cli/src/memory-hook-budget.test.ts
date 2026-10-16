/**
 * P4.2 at the hook: the Submit's budget abort (A4 §5.1 step 0, A2 §2.8). A human Submit past its 150 ms prints
 * nothing, says so in its wide event (A5 `abort_rate`), records no delivery and keeps what it encoded; two aborts at
 * an `on` point trip the breaker (EXECUTION §5: aborts ≤ 0.5% of 200). The budget clock starts when a hook's handler
 * does, not at its process's start; here the call passes an origin in the past instead of waiting, and the budget is
 * 5 s, so a Submit meant to be in budget stays so on a loaded machine (`budgetOf`'s tests cover the 150 ms default).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMemory } from "../../../src/index";
import { budgetOf, memoryHookResponse, SUBMIT_BUDGET_MS } from "./memory-hook";

const SESSION = "s-budget";
const RULE = "we use pnpm in this repo, never npm";
const CUE = "install the dependencies with npm";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const BUDGET_MS = 5_000;
/** How late a Submit meant to abort starts: past the budget. */
const LATE = BUDGET_MS + 1_000;

let dir = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_SUBMIT_BUDGET_MS"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-budget-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
  process.env.EDEN_SUBMIT_BUDGET_MS = String(BUDGET_MS);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

/** A Submit whose budget clock started `late` ms ago. */
function submit(prompt: string, late = 0, event = "UserPromptSubmit"): string | undefined {
  const out = memoryHookResponse(
    { hook_event_name: event, session_id: SESSION, prompt },
    undefined,
    performance.now() - late,
  );
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

type Wide = Record<string, unknown> & { ev: string; aborted?: boolean };

function wideEvents(): Wide[] {
  const events = join(dir, "memory", "hook.log.d");
  if (!existsSync(events)) return [];
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Wide);
}

function ledger(): Array<Record<string, unknown>> {
  const path = join(dir, "memory", "windows", SESSION, "delivery.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every row text of every repo store under the memory root. */
function storedTexts(): string[] {
  const repos = join(dir, "memory", "repos");
  if (!existsSync(repos)) return [];
  return readdirSync(repos).flatMap((key) => {
    const path = join(repos, key, "memories.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as { text?: string } | [string, string];
        return Array.isArray(row) ? row[1] : String(row.text ?? "");
      });
  });
}

function breakerFile(): Record<string, { mode: string; cause: string }> {
  const path = join(dir, "home", "flags.auto.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

describe("the Submit's budget abort", () => {
  test("in budget, the cue gets its rule (the control)", () => {
    submit(RULE);
    expect(submit(CUE)).toContain("pnpm");
    expect(wideEvents().every((event) => event.aborted === false)).toBe(true);
  });

  test("past its budget a Submit prints nothing, logs aborted, records no delivery, and keeps what it encoded", () => {
    submit(RULE);
    const before = ledger().filter((record) => record.k === "deliver").length;
    expect(submit(CUE, LATE)).toBeUndefined();
    const last = wideEvents().at(-1)!;
    expect(last).toMatchObject({ ev: "UserPromptSubmit", submit: "human", aborted: true });
    expect(ledger().filter((record) => record.k === "deliver").length).toBe(before);
    expect(storedTexts().some((text) => text.toLowerCase().includes("install the dependencies"))).toBe(true);
  });

  test("an aborted cue's item is still owed: the next Submit in budget delivers it", () => {
    submit(RULE);
    expect(submit(CUE, LATE)).toBeUndefined();
    expect(submit(CUE)).toContain("pnpm");
  });

  test("two aborts at an on point force it to shadow (aborts ≤ 0.5% of the last 200)", () => {
    submit(RULE);
    submit(CUE, LATE);
    expect(breakerFile()["deliver.submit"]).toBeUndefined();
    submit("which package manager again?", LATE);
    expect(breakerFile()["deliver.submit"]).toMatchObject({
      mode: "shadow",
      cause: expect.stringMatching(/2 budget aborts/),
    });
  });

  test("a Submit whose budget runs out during retrieval aborts before the ledger records it (review round 1)", () => {
    memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: RULE });
    process.env.EDEN_SUBMIT_BUDGET_MS = "400";
    const recall = AgentMemory.prototype.recall;
    const slow = spyOn(AgentMemory.prototype, "recall").mockImplementation(function (this: AgentMemory, ...args) {
      const out = recall.apply(this, args as Parameters<typeof recall>);
      const until = performance.now() + 450;
      while (performance.now() < until) {}
      return out;
    });
    try {
      expect(submit(CUE)).toBeUndefined();
    } finally {
      slow.mockRestore();
    }
    expect(wideEvents().at(-1)).toMatchObject({ ev: "UserPromptSubmit", aborted: true });
    expect(ledger().filter((record) => record.k === "deliver")).toHaveLength(0);
  });

  test("only a human Submit aborts: a non-human one and PreCompact never do", () => {
    submit(RULE);
    submit("<task-notification>build finished</task-notification>", LATE);
    submit(CUE, LATE, "PreCompact");
    expect(wideEvents().some((event) => event.aborted)).toBe(false);
  });
});

describe("the budget clock in a hook process", () => {
  /** A hook process whose start is `before` ms slower than usual (a loaded machine, a cold module cache). */
  function slowStartSubmit(prompt: string, before: number, budget: number): void {
    const hook = join(import.meta.dir, "memory-hook.ts");
    const script = [
      `const until = performance.now() + ${before};`,
      "while (performance.now() < until) {}",
      `const { runMemoryHookStdin } = await import(${JSON.stringify(hook)});`,
      "await runMemoryHookStdin();",
    ].join("\n");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, EDEN_SUBMIT_BUDGET_MS: String(budget) },
      stdin: new TextEncoder().encode(
        JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
      ),
    });
    expect(child.exitCode).toBe(0);
  }

  test("starts at the handler, not the process: a slow start alone does not abort (user's choice, 2026-10-16)", () => {
    slowStartSubmit(RULE, 1_500, 1_000);
    expect(wideEvents().at(-1)).toMatchObject({ ev: "UserPromptSubmit", submit: "human", aborted: false });
  });
});

describe("budgetOf (EDEN_SUBMIT_BUDGET_MS)", () => {
  const at = (ms: number) => performance.now() - ms;

  test("150 ms when unset", () => {
    expect(budgetOf(at(SUBMIT_BUDGET_MS - 20), "")()).toBe(false);
    expect(budgetOf(at(SUBMIT_BUDGET_MS + 20), "")()).toBe(true);
  });

  test("a number of ms sets it; 0 and off turn it off; anything else keeps the default", () => {
    expect(budgetOf(at(400), "500")()).toBe(false);
    expect(budgetOf(at(600), "500")()).toBe(true);
    expect(budgetOf(at(10_000), "0")()).toBe(false);
    expect(budgetOf(at(10_000), "off")()).toBe(false);
    expect(budgetOf(at(SUBMIT_BUDGET_MS + 20), "soon")()).toBe(true);
    expect(budgetOf(at(SUBMIT_BUDGET_MS + 20), "-5")()).toBe(true);
  });
});
