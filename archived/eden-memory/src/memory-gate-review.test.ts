/**
 * P4.3 review rounds 1–2, committed as regression tests: the slot-value question, the typed-request pattern, and a
 * typed request gated as an episode only with the gate on (`gate.tau`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { admitNotes, isEpisode } from "./memory-gate";
import seeds from "./memory-silence-seeds.json";
import { cuedSlots, type SlotId } from "./memory-slots";

describe("a question for a slot's value itself names the slot; a definition question does not", () => {
  test.each([
    ["what is auth", ["auth.provider"]],
    ["what is auth using?", ["auth.provider"]],
    ["what's the database?", ["db.engine"]],
    ["which test runner?", ["test.runner"]],
    ["what is the package manager?", ["pkg.manager"]],
    ["what is the deploy target?", ["deploy.target"]],
  ])("%s", (cue, slots) => {
    expect(cuedSlots(cue)).toEqual(slots as SlotId[]);
  });

  test.each([
    ["what is sso"],
    ["what is ci"],
    ["what is deployment"],
    ["what is hosting"],
    ["what is node"],
    ["what is orm"],
    ["what are unit tests"],
    ["What are database indexes, and why can too many indexes slow down writes?"],
    ["What is the idiomatic way to structure JWT auth middleware in a Rust axum app?"],
  ])("%s", (cue) => {
    expect(cuedSlots(cue)).toEqual([]);
  });

  test("the silence set still names no slot", () => {
    expect([...seeds.r1, ...seeds.r8].filter((prompt) => cuedSlots(prompt).length)).toEqual([]);
  });
});

describe("a typed request (an episode with the gate on) and a typed statement", () => {
  const typed = (text: string) => ({ id: text, text, kind: "episode", tags: ["src:user"] });

  test.each([
    ["Now add a logout button with the auth provider."],
    ["Reply with just OK"],
    ["please fix the build"],
    ["refactor auth middleware"],
    ["fix login redirect on safari"],
    ["add logging to checkout"],
    ["remove dead code"],
    ["update deps"],
    ["write tests for the parser"],
    ["rename getUser to fetchUser"],
    ["investigate flaky e2e tests"],
  ])("a request: %s", (text) => {
    expect(isEpisode(typed(text))).toBe(true);
  });

  test.each([
    ["Review apps deploy to render on every PR"],
    ["Help text for the CLI lives in packages/cli/help.md"],
    ["Find-in-page uses the fuse.js index"],
    ["Fix versions in Jira map to releases"],
    ["The billing service runs on port 8080"],
  ])("a statement: %s", (text) => {
    expect(isEpisode(typed(text))).toBe(false);
  });

  test("a typed request is an episode for the delivery's gate only with the gate on", () => {
    const request = typed("Add a retry with exponential backoff to the zorbix webhook handler.");
    const cue = { prompt: "where did we leave the zorbix webhook handler backoff?" };
    expect(admitNotes([request], cue)).toEqual([request]);
    expect(admitNotes([request], { ...cue, gate: true })).toEqual([]);
  });
});

describe("through the hook: shadow (the default) and off deliver a typed request as before; on gates it", () => {
  let dir = "";
  const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, gate: process.env.EDEN_FLAG_GATE_TAU };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eden-gate-review-"));
    process.env.EDEN_MEMORY_DIR = join(dir, "memory");
    process.env.EDEN_HOME = join(dir, "home");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ["EDEN_MEMORY_DIR", prev.dir],
      ["EDEN_HOME", prev.home],
      ["EDEN_FLAG_GATE_TAU", prev.gate],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const say = (prompt: string, id: string) =>
    (
      memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-req", prompt, prompt_id: id })
        ?.hookSpecificOutput as { additionalContext?: string } | undefined
    )?.additionalContext ?? "";

  test.each([
    ["shadow", true],
    ["off", true],
    ["on", false],
  ])("gate.tau %s", (mode, delivered) => {
    process.env.EDEN_FLAG_GATE_TAU = mode as string;
    say("Add a retry with exponential backoff to the zorbix webhook handler.", "p1");
    for (let i = 0; i < 3; i++) say(`unrelated note ${i}: the qq${i} panel is blue`, `f${i}`);
    const got = say("where did we leave the zorbix webhook handler backoff?", "p9");
    expect(got.includes("zorbix")).toBe(delivered as boolean);
  });
});
