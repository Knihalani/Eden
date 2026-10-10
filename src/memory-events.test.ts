/**
 * X11's retention for `hook.log.d/` (P1.1): day files are kept 90 days, then replaced by a daily aggregate that holds
 * counts and times only.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendWideEvent, EVENTS_DIR, recentEvents, retainEvents, type WideEvent } from "./memory-events";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-events-"));
  roots.push(dir);
  return dir;
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");

function event(t: number, extra: Partial<WideEvent> = {}): WideEvent {
  return {
    t,
    ev: "UserPromptSubmit",
    point: "deliver.submit",
    mode: "on",
    submit: "human",
    ms: 10,
    aborted: false,
    ...extra,
  };
}

test("day files older than 90 days become daily aggregates of counts and times; newer ones stay", () => {
  const dir = root();
  const old = NOW - 91 * DAY;
  appendWideEvent(
    dir,
    event(old, { cids: ["a1b2c3d4/E:1", "a1b2c3d4/E:2"], drops: { gate: 2, refractory: 1 }, ms: 12 }),
  );
  appendWideEvent(dir, event(old + 1, { ms: 30, prompt_hash: "h1" }));
  appendWideEvent(dir, event(old + 2, { submit: "non-human", nonhuman: "task-notification", ms: 2 }));
  appendWideEvent(
    dir,
    event(old + 3, {
      ev: "Stop",
      point: undefined,
      mode: undefined,
      submit: undefined,
      ms: 50,
      err: "TypeError at x.ts:1",
    }),
  );
  const recent = NOW - 89 * DAY;
  appendWideEvent(dir, event(recent));
  retainEvents(dir, NOW);
  const names = readdirSync(join(dir, EVENTS_DIR)).sort();
  const oldDay = new Date(old).toISOString().slice(0, 10);
  const recentDay = new Date(recent).toISOString().slice(0, 10);
  expect(names).toContain(`${recentDay}.jsonl`);
  expect(names).not.toContain(`${oldDay}.jsonl`);
  const aggregate = JSON.parse(readFileSync(join(dir, EVENTS_DIR, "daily", `${oldDay}.json`), "utf8"));
  expect(aggregate.day).toBe(oldDay);
  expect(aggregate.events).toBe(4);
  const human = aggregate.groups.find((g: { submit?: string }) => g.submit === "human");
  expect(human).toMatchObject({ ev: "UserPromptSubmit", point: "deliver.submit", n: 2, packets: 1, cids: 2 });
  expect(human.drops).toEqual({ gate: 2, refractory: 1 });
  expect(human.ms).toMatchObject({ max: 30 });
  expect(aggregate.groups.find((g: { ev: string }) => g.ev === "Stop")).toMatchObject({ n: 1, errors: 1 });
  expect(JSON.stringify(aggregate)).not.toContain("h1");
});

test("retention is idempotent and leaves the breaker's reader alone", () => {
  const dir = root();
  appendWideEvent(dir, event(NOW - 100 * DAY));
  appendWideEvent(dir, event(NOW - DAY));
  retainEvents(dir, NOW);
  const once = readdirSync(join(dir, EVENTS_DIR, "daily"));
  retainEvents(dir, NOW);
  expect(readdirSync(join(dir, EVENTS_DIR, "daily"))).toEqual(once);
  expect(recentEvents(dir, "deliver.submit", 10)).toHaveLength(1);
  expect(existsSync(join(root(), EVENTS_DIR))).toBe(false);
  retainEvents(join(root(), "none"), NOW);
});

test("the breaker's reader leaves out the wrap's events, which share deliver.submit (P1.1 review)", () => {
  const dir = root();
  appendWideEvent(dir, event(NOW - 2));
  appendWideEvent(dir, event(NOW - 1, { ev: "wrap" }));
  expect(recentEvents(dir, "deliver.submit", 10).map((e) => e.ev)).toEqual(["UserPromptSubmit"]);
});
