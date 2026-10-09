/**
 * P0.8: the circuit breaker (EXECUTION §5): over a point's last 200 wide events, unhandled exceptions ≤ 0.1% and
 * budget aborts ≤ 0.5%, or the point is forced to shadow for 24 h; the next SessionStart says so once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKER_HOLD_MS, overBudget, takeNotice, tripIfOverBudget } from "./memory-breaker";
import { appendWideEvent, errorTag, recentEvents, type WideEvent } from "./memory-events";
import { resolveFlags, type Flag } from "./memory-flags";

const NOW = Date.parse("2026-10-09T12:00:00Z");
let root = "";
let home = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eden-breaker-"));
  home = join(root, "home");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function log(point: Flag, n: number, extra: Partial<WideEvent> = {}, t = NOW): void {
  for (let i = 0; i < n; i++) appendWideEvent(root, { t, ev: "UserPromptSubmit", point, ms: 1, aborted: false, ...extra });
}

const flags = () => resolveFlags(undefined, { EDEN_HOME: home });
const path = () => join(home, "flags.auto.json");

describe("overBudget", () => {
  test("one exception in the last 200 is over 0.1%; one abort is not over 0.5%, two are", () => {
    log("deliver.submit", 199);
    expect(overBudget(root, "deliver.submit")).toBeUndefined();
    log("deliver.submit", 1, { aborted: true });
    expect(overBudget(root, "deliver.submit")).toBeUndefined();
    log("deliver.submit", 1, { aborted: true });
    expect(overBudget(root, "deliver.submit")).toBe("2 budget aborts in its last 200 invocations");
    log("deliver.submit", 1, { err: "TypeError at x.ts:1" });
    expect(overBudget(root, "deliver.submit")).toBe(
      "1 unhandled exception and 2 budget aborts in its last 200 invocations",
    );
  });

  test("only the point's own last 200 count, across day files", () => {
    log("deliver.submit", 1, { err: "TypeError at x.ts:1" }, NOW - 86_400_000);
    log("deliver.session_start", 50, { err: "TypeError at x.ts:1" });
    log("deliver.submit", 199);
    expect(overBudget(root, "deliver.submit")).toBe("1 unhandled exception in its last 200 invocations");
    log("deliver.submit", 1);
    expect(overBudget(root, "deliver.submit")).toBeUndefined();
    expect(recentEvents(root, "deliver.submit", 200)).toHaveLength(200);
  });
});

describe("tripIfOverBudget", () => {
  test("forces an on point to shadow for 24 h; a point not on is left alone", () => {
    log("deliver.submit", 1, { err: "TypeError at x.ts:1" });
    log("deliver.session_start", 1, { err: "TypeError at x.ts:1" });
    const off = { ...flags(), "deliver.session_start": { mode: "off" as const, source: "user" as const } };
    expect(tripIfOverBudget(root, "deliver.session_start", off, NOW, path())).toBeUndefined();
    expect(existsSync(path())).toBe(false);
    const entry = tripIfOverBudget(root, "deliver.submit", flags(), NOW, path());
    expect(entry).toEqual({
      mode: "shadow",
      since: NOW,
      until: NOW + BREAKER_HOLD_MS,
      cause: "1 unhandled exception in its last 200 invocations",
      announced: false,
    });
    expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({ "deliver.submit": entry });
  });

  test("the next SessionStart's notice comes once", () => {
    log("deliver.submit", 1, { err: "TypeError at x.ts:1" });
    tripIfOverBudget(root, "deliver.submit", flags(), NOW, path());
    expect(takeNotice(NOW, path())).toBe(
      "Eden memory circuit breaker: UserPromptSubmit delivery (deliver.submit) is in shadow mode until " +
        "2026-10-10T12:00:00Z: 1 unhandled exception in its last 200 invocations. See eden doctor.",
    );
    expect(takeNotice(NOW, path())).toBeUndefined();
    expect(takeNotice(NOW + BREAKER_HOLD_MS + 1, path())).toBeUndefined();
  });
});

describe("errorTag", () => {
  test("the class and the throwing line, never the message", () => {
    let err: unknown;
    try {
      JSON.parse("{ the user's secret prompt");
    } catch (caught) {
      err = caught;
    }
    expect(errorTag(err)).toMatch(/^SyntaxError( at [\w.-]+:\d+)?$/);
    expect(errorTag(new RangeError("text"))).toMatch(/^RangeError at memory-breaker\.test\.ts:\d+$/);
    expect(errorTag("thrown string")).toBe("string");
  });
});
