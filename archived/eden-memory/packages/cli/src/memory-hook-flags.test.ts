/**
 * P0.8 at the hook (EXECUTION X7, §5): the delivery-point flags (`off` is identity, `shadow` runs the pipeline and
 * writes only the shadow ledger), one wide event per invocation, and what an exception in the handler does: nothing
 * printed, the error logged by class, and at an `on` point the circuit breaker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-flags";
const RULE = "we use pnpm in this repo, never npm";
/** A later prompt that cues the rule without restating it (D26 would not deliver back what the prompt says). */
const CUE = "install the dependencies with npm";
const NOW = Date.parse("2026-10-09T12:00:00Z");

let dir = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-flags-"));
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

function setFlags(flags: Record<string, string>, file = join(dir, "home", "flags.json")): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(flags));
}

function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  return memoryHookResponse({ hook_event_name: event, session_id: SESSION, ...extra });
}

function submit(prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const out = hook("UserPromptSubmit", { prompt, ...extra });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

function windowFile(name: string): string {
  const path = join(dir, "memory", "windows", SESSION, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function records(name: string): Array<Record<string, unknown>> {
  return windowFile(name)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Wide = Record<string, unknown> & { ev: string; point?: string; mode?: string; err?: string };

function wideEvents(): Wide[] {
  const events = join(dir, "memory", "hook.log.d");
  if (!existsSync(events)) return [];
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Wide);
}

function breakerFile(): Record<string, { mode: string; until: number; announced: boolean; cause: string }> {
  const path = join(dir, "home", "flags.auto.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

describe("deliver.submit (X7)", () => {
  test("no flag file: today's behaviour, the cue packs the rule", () => {
    submit(RULE);
    expect(submit(CUE)).toContain(RULE);
    expect(records("delivery.log").some((record) => record.k === "deliver")).toBe(true);
  });

  test("off: nothing printed and no ledger, but the prompt is still encoded", () => {
    setFlags({ "deliver.submit": "off" });
    expect(submit(RULE)).toBeUndefined();
    expect(submit(CUE)).toBeUndefined();
    expect(windowFile("delivery.log")).toBe("");
    expect(windowFile("delivery.shadow.log")).toBe("");
    setFlags({ "deliver.submit": "on" });
    expect(submit(CUE)).toContain(RULE);
  });

  test("shadow: nothing printed; the shadow ledger holds the turns and what it would have delivered", () => {
    setFlags({ "deliver.submit": "shadow" });
    expect(submit(RULE)).toBeUndefined();
    expect(submit(CUE)).toBeUndefined();
    expect(windowFile("delivery.log")).toBe("");
    const shadow = records("delivery.shadow.log");
    expect(shadow.filter((record) => record.k === "turn")).toHaveLength(2);
    const delivered = shadow.filter((record) => record.k === "deliver");
    expect(delivered.length).toBeGreaterThan(0);
    const cueEvent = wideEvents().findLast((event) => event.ev === "UserPromptSubmit")!;
    expect(cueEvent).toMatchObject({ point: "deliver.submit", mode: "shadow", submit: "human", hturn: 2 });
    expect(cueEvent.cids).toEqual(delivered.map((record) => record.cid));
  });

  test("shadow's refractory rule reads its own ledger: the same cue a turn later would deliver nothing new", () => {
    setFlags({ "deliver.submit": "shadow" });
    submit(RULE);
    submit(CUE);
    submit(CUE, { prompt_id: "p-again" });
    const events = wideEvents().filter((event) => event.ev === "UserPromptSubmit");
    const [first, again] = events.slice(-2) as [Wide, Wide];
    expect((first.cids as string[]).length).toBeGreaterThan(0);
    expect(again.cids).toEqual([]);
    expect((again.drops as Record<string, number>).refractory).toBeGreaterThan(0);
  });

  test("a live point does not read the shadow ledger", () => {
    setFlags({ "deliver.submit": "shadow" });
    submit(RULE);
    submit(CUE);
    setFlags({});
    expect(submit(CUE, { prompt_id: "p-live" })).toContain(RULE);
  });

  test("would_preempt: the user restates, within 3 human turns, what a shadow packet held", () => {
    setFlags({ "deliver.submit": "shadow" });
    submit(RULE);
    submit(CUE);
    const cids = wideEvents().findLast((event) => event.ev === "UserPromptSubmit")!.cids as string[];
    submit(RULE, { prompt_id: "p-restated" });
    const restated = wideEvents().findLast((event) => event.ev === "UserPromptSubmit")!;
    expect(restated.would_preempt).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(cids).toEqual(expect.arrayContaining(restated.would_preempt as string[]));
  });

  test("an unknown value resolves to shadow at Submit", () => {
    setFlags({ "deliver.submit": "maybe" });
    submit(RULE);
    expect(submit(CUE)).toBeUndefined();
    expect(records("delivery.shadow.log").some((record) => record.k === "deliver")).toBe(true);
  });

  test("the environment beats the user file", () => {
    setFlags({ "deliver.submit": "on" });
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "off";
    submit(RULE);
    expect(submit(CUE)).toBeUndefined();
    expect(windowFile("delivery.log")).toBe("");
  });

  test("the repo file beats the user file, from any folder of the repo", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    setFlags({ "deliver.submit": "off" }, join(repo, ".eden", "flags.json"));
    setFlags({ "deliver.submit": "on" });
    const cwd = join(repo, "apps", "web");
    submit(RULE, { cwd });
    expect(submit(CUE, { cwd })).toBeUndefined();
    // Outside the repo the user file applies. That folder has its own store (D1), so the rule is said there too.
    submit(RULE, { cwd: dir, prompt_id: "p-rule-elsewhere" });
    expect(submit(CUE, { cwd: dir, prompt_id: "p-elsewhere" })).toContain(RULE);
  });
});

describe("deliver.session_start (X7)", () => {
  /** A session that leaves a gist for the next SessionStart to brief. */
  function earlierSession(): void {
    memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: "s-earlier", prompt: RULE });
    memoryHookResponse({ hook_event_name: "Stop", session_id: "s-earlier", last_assistant_message: "Noted." });
  }

  function context(out: Record<string, unknown> | null): string | undefined {
    return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
  }

  test("on by default; off prints nothing and writes no ledger; shadow writes only the shadow ledger", () => {
    earlierSession();
    expect(context(hook("SessionStart", { source: "startup" }))).toContain("pnpm");
    rmSync(join(dir, "memory", "windows", SESSION), { recursive: true, force: true });
    setFlags({ "deliver.session_start": "off" });
    expect(hook("SessionStart", { source: "startup" })).toBeNull();
    expect(existsSync(join(dir, "memory", "windows", SESSION))).toBe(false);
    setFlags({ "deliver.session_start": "shadow" });
    expect(hook("SessionStart", { source: "startup" })).toBeNull();
    expect(windowFile("delivery.log")).toBe("");
    expect(records("delivery.shadow.log").some((record) => record.k === "deliver")).toBe(true);
  });

  test("a compaction starts an epoch in the ledger of each mode in use", () => {
    setFlags({ "deliver.session_start": "shadow" });
    hook("SessionStart", { source: "compact" });
    expect(records("delivery.shadow.log")).toContainEqual(expect.objectContaining({ k: "epoch" }));
    expect(records("delivery.log")).toContainEqual(expect.objectContaining({ k: "epoch" }));
  });

  test("an unknown value resolves to off", () => {
    earlierSession();
    setFlags({ "deliver.session_start": "sometimes" });
    expect(hook("SessionStart", { source: "startup" })).toBeNull();
    expect(windowFile("delivery.shadow.log")).toBe("");
  });
});

describe("wide events", () => {
  test("one per invocation at every memory event, holding hashes and ids but no prompt text", () => {
    const events = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "SubagentStop"];
    for (const ev of events) hook(ev, { prompt: RULE, tool_name: "Read", tool_response: "pnpm-lock.yaml" });
    hook("SessionEnd", { reason: "exit" });
    const logged = wideEvents();
    expect(logged.map((event) => event.ev)).toEqual([...events, "SessionEnd"]);
    const text = readdirSync(join(dir, "memory", "hook.log.d"))
      .map((name) => readFileSync(join(dir, "memory", "hook.log.d", name), "utf8"))
      .join("");
    expect(text).not.toContain("pnpm");
    expect(readdirSync(join(dir, "memory", "hook.log.d"))).toEqual(["2026-10-09.jsonl"]);
    const submitted = logged.find((event) => event.ev === "UserPromptSubmit")!;
    expect(submitted).toMatchObject({ point: "deliver.submit", mode: "on", submit: "human", aborted: false });
    expect(submitted.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof submitted.ms).toBe("number");
    expect(logged.find((event) => event.ev === "Stop")!.point).toBeUndefined();
  });

  test("a non-human submit is logged as one, with nothing else done", () => {
    submit("<task-notification>build finished</task-notification>");
    expect(wideEvents()).toEqual([expect.objectContaining({ ev: "UserPromptSubmit", submit: "non-human" })]);
    expect(windowFile("delivery.log")).toBe("");
  });

  test("read-only and off write nothing at all", () => {
    for (const consent of ["readonly", "off", "garbled"]) {
      process.env.EDEN_MEMORY = consent;
      submit(RULE);
    }
    expect(wideEvents()).toEqual([]);
  });
});

describe("an exception in the handler (injected)", () => {
  /** A payload whose transcript path throws when read: every memory event reads it once its store is open. */
  function throwing(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return Object.defineProperty(
      { hook_event_name: event, session_id: SESSION, prompt: CUE, ...extra },
      "transcript_path",
      {
        enumerable: true,
        get() {
          throw new TypeError(`injected ${RULE}`);
        },
      },
    );
  }

  test("every memory event returns null, and its wide event names the error's class and line, not its text", () => {
    const events = [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "PreCompact",
      "SubagentStop",
      "SessionEnd",
    ];
    for (const ev of events) expect(memoryHookResponse(throwing(ev))).toBeNull();
    const logged = wideEvents();
    expect(logged.map((event) => event.ev)).toEqual(events);
    for (const event of logged) expect(event.err).toMatch(/^TypeError at memory-hook-flags\.test\.ts:\d+$/);
    expect(JSON.stringify(logged)).not.toContain("pnpm");
  });

  test("at an on point the breaker forces shadow for 24 h, and the next SessionStart says so once", () => {
    submit(RULE);
    expect(memoryHookResponse(throwing("UserPromptSubmit"))).toBeNull();
    const forced = breakerFile()["deliver.submit"]!;
    expect(forced).toMatchObject({ mode: "shadow", until: NOW + 24 * 3600 * 1000, announced: false });
    expect(forced.cause).toBe("1 unhandled exception in its last 200 invocations");
    expect(submit(CUE)).toBeUndefined();
    expect(records("delivery.shadow.log").some((record) => record.k === "deliver")).toBe(true);
    const notice = hook("SessionStart", { source: "startup" })?.systemMessage;
    expect(notice).toContain("UserPromptSubmit delivery (deliver.submit) is in shadow mode until 2026-10-10T12:00:00Z");
    expect(hook("SessionStart", { source: "startup" })?.systemMessage).toBeUndefined();
    process.env.EDEN_NOW = String(NOW + 24 * 3600 * 1000 + 1);
    submit(CUE, { prompt_id: "p-next-day" });
    expect(wideEvents().at(-1)).toMatchObject({ ev: "UserPromptSubmit", mode: "on" });
  });

  test("at a point already in shadow, or at an event with no point, nothing is forced", () => {
    setFlags({ "deliver.submit": "shadow" });
    memoryHookResponse(throwing("UserPromptSubmit"));
    memoryHookResponse(throwing("Stop"));
    expect(breakerFile()).toEqual({});
  });
});

describe("review round 1 probes (slice-reviewer)", () => {
  const every = (mode: string) =>
    Object.fromEntries(["deliver.submit", "deliver.session_start"].map((flag) => [flag, mode]));

  test("off is identity at every event: a PreCompact that carries a prompt-like field returns no context", () => {
    submit(RULE);
    setFlags(every("off"));
    expect(submit(CUE, { prompt_id: "p2" })).toBeUndefined();
    expect(hook("PreCompact", { prompt: CUE, trigger: "manual" })).toBeNull();
    setFlags(every("shadow"));
    expect(hook("PreCompact", { prompt: CUE, trigger: "manual" })).toBeNull();
  });

  test("shadow after a switch from on: a compaction re-arms what the live point delivered before it", () => {
    submit(RULE, { prompt_id: "p1" });
    expect(submit(CUE, { prompt_id: "p2" })).toContain(RULE);
    setFlags(every("shadow"));
    hook("SessionStart", { source: "compact" });
    submit(CUE, { prompt_id: "p3" });
    const last = wideEvents().findLast((event) => event.ev === "UserPromptSubmit")!;
    expect((last.cids as string[]).length).toBeGreaterThan(0);
  });

  test("control: all on, a compaction re-arms the rule", () => {
    submit(RULE, { prompt_id: "p1" });
    expect(submit(CUE, { prompt_id: "p2" })).toContain(RULE);
    hook("SessionStart", { source: "compact" });
    expect(submit(CUE, { prompt_id: "p3" })).toContain(RULE);
  });

  test("a non-human submit's wide event keeps its prompt_id, hash and hturn, and the D24 rule it matched", () => {
    submit(RULE, { prompt_id: "p1" });
    submit("<task-notification>build finished</task-notification>", { prompt_id: "p-n" });
    expect(wideEvents().at(-1)).toMatchObject({
      submit: "non-human",
      nonhuman: "task-notification",
      prompt_id: "p-n",
      hturn: 1,
    });
    expect(wideEvents().at(-1)!.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    submit('Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>');
    expect(wideEvents().at(-1)).toMatchObject({ nonhuman: "agent-message", preamble: true });
  });
});
