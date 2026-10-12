/**
 * P2.5 at the hook (A4 §5.3, D23, D25, D27, X7): `PreToolUse(Agent)` records a launch's task paths and classes, and
 * SubagentStart briefs the subagent ≤ 3 bullets for its task's scope, its task's and its type's policies; a fork gets
 * nothing its parent holds; a child's shadow set follows its type; its ledger measures distance on its own transcript.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../../src/memory-ledger";
import { memoryHookResponse } from "./memory-hook";
import { spawnHookResponse } from "./memory-spawn-hook";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const PARENT = "s-main";
const CLERK = "In apps/web the auth provider is Clerk.";
const CLI_AUTH = "packages/cli has no auth.";
const NO_MERGE = "Don't merge PRs yourself.";

let dir = "";
let project = "";
let calls = 0;
const ENV_KEYS = [
  "EDEN_MEMORY_DIR",
  "EDEN_HOME",
  "EDEN_MEMORY",
  "EDEN_NOW",
  "EDEN_FLAG_DELIVER_SUBAGENT",
  "EDEN_FLAG_DELIVER_SUBMIT",
] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-subagent-"));
  project = join(dir, "project");
  for (const folder of ["apps/web/app", "packages/cli/src"]) mkdirSync(join(project, folder), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  process.env.EDEN_NOW = String(NOW);
  process.env.EDEN_FLAG_DELIVER_SUBAGENT = "on";
  delete process.env.EDEN_MEMORY;
  delete process.env.EDEN_FLAG_DELIVER_SUBMIT;
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(transcript(PARENT), `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
});

const transcript = (session: string) => join(dir, "projects", `${session}.jsonl`);
const childTranscriptOf = (agent: string) => join(dir, "projects", PARENT, "subagents", `agent-${agent}.jsonl`);
const windows = () => join(process.env.EDEN_MEMORY_DIR!, "windows");
const childWindow = (agent: string) => join(windows(), `${PARENT}--${agent}`);

function tick(ms = 1_000): void {
  process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + ms);
}

function contextOf(out: Record<string, unknown> | null): string {
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

const bullets = (packet: string) => packet.split("\n").filter((line) => line.startsWith("- "));

/** The user states facts and the merge rule in an earlier session of the repo. */
function plant(lines: string[] = [CLERK, CLI_AUTH, NO_MERGE]): void {
  lines.forEach((prompt, at) => {
    memoryHookResponse({
      session_id: "s-facts",
      cwd: project,
      hook_event_name: "UserPromptSubmit",
      prompt,
      prompt_id: `f${at}`,
    });
    tick(60_000);
  });
}

/** The parent's Agent call, as `PreToolUse(Agent)` sees it; returns its tool_use_id. */
function launch(task: string, type?: string, extra: Record<string, unknown> = {}): string {
  const id = `toolu_${++calls}`;
  spawnHookResponse({
    session_id: PARENT,
    cwd: project,
    transcript_path: transcript(PARENT),
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: id,
    tool_input: { description: "task", prompt: task, ...(type ? { subagent_type: type } : {}) },
    ...extra,
  });
  return id;
}

function subagentStart(agent: string, type: string): string {
  const out = memoryHookResponse({
    session_id: PARENT,
    cwd: project,
    transcript_path: transcript(PARENT),
    hook_event_name: "SubagentStart",
    agent_id: agent,
    agent_type: type,
  });
  tick();
  return contextOf(out);
}

function submit(prompt: string, promptId: string): string {
  const out = memoryHookResponse({
    session_id: PARENT,
    cwd: project,
    transcript_path: transcript(PARENT),
    hook_event_name: "UserPromptSubmit",
    prompt,
    prompt_id: promptId,
  });
  tick(60_000);
  return contextOf(out);
}

function readBatch(path: string, promptId: string): void {
  memoryHookResponse({
    session_id: PARENT,
    cwd: project,
    transcript_path: transcript(PARENT),
    hook_event_name: "PostToolBatch",
    prompt_id: promptId,
    tool_calls: [
      {
        tool_name: "Read",
        tool_input: { file_path: join(project, path) },
        tool_use_id: `r${++calls}`,
        tool_response: "x",
      },
    ],
  });
  tick();
}

function events(): Record<string, unknown>[] {
  const root = join(process.env.EDEN_MEMORY_DIR!, "hook.log.d");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .flatMap((file) => readFileSync(join(root, file), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("PreToolUse(Agent) records the launch (A4 §5.3)", () => {
  test("in the session's window: its id, type, task paths and classes, never the task's text; it prints nothing", () => {
    const id = launch("merge the dependabot PR in apps/web once CI is green", "general-purpose");
    const log = readFileSync(join(windows(), PARENT, "spawn.log"), "utf8");
    const record = JSON.parse(log.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ k: "spawn", id, type: "general-purpose", paths: ["apps/web"] });
    expect(record.classes).toContain("integrate");
    expect(log).not.toContain("dependabot");
  });

  test("a subagent's own launch goes to the session's window too", () => {
    launch("look at apps/web", "Explore", { agent_id: "a-nested" });
    expect(existsSync(join(windows(), PARENT, "spawn.log"))).toBe(true);
    expect(existsSync(join(windows(), `${PARENT}--a-nested`, "spawn.log"))).toBe(false);
  });

  test("nothing for another tool, with the point off, or without write consent", () => {
    spawnHookResponse({ session_id: PARENT, cwd: project, hook_event_name: "PreToolUse", tool_name: "Bash" });
    process.env.EDEN_FLAG_DELIVER_SUBAGENT = "off";
    launch("look at apps/web", "Explore");
    process.env.EDEN_FLAG_DELIVER_SUBAGENT = "on";
    process.env.EDEN_MEMORY = "readonly";
    launch("look at apps/web", "Explore");
    expect(existsSync(join(windows(), PARENT, "spawn.log"))).toBe(false);
  });

  test("fails open on a payload of the wrong shape", () => {
    expect(() =>
      spawnHookResponse({ session_id: PARENT, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: 7 }),
    ).not.toThrow();
  });
});

describe("SubagentStart: the task's scope (A4 §5.3)", () => {
  test("the subagent gets its task's rows, not the other package's", () => {
    plant();
    launch("fix the redirect in apps/web/app/login.ts", "general-purpose");
    const packet = subagentStart("a1", "general-purpose");
    expect(packet).toContain("Clerk");
    expect(packet).not.toContain("packages/cli has no auth");
  });

  test("two launches of one type, each followed by its SubagentStart (Claude Code's order), get their own scopes", () => {
    plant();
    launch("look at apps/web/app/login.ts", "Explore");
    expect(subagentStart("a1", "Explore")).toContain("Clerk");
    launch("look at packages/cli/src/index.ts", "Explore");
    expect(subagentStart("a2", "Explore")).toContain("packages/cli has no auth");
  });

  test("two launches before either SubagentStart: the newest unconsumed of its type, each once", () => {
    plant();
    launch("look at apps/web/app/login.ts", "Explore");
    launch("look at packages/cli/src/index.ts", "Explore");
    expect(subagentStart("a1", "Explore")).toContain("packages/cli has no auth");
    expect(subagentStart("a2", "Explore")).toContain("Clerk");
  });

  test("no launch recorded: the parent's recent paths", () => {
    plant();
    readBatch("packages/cli/src/index.ts", "p1");
    const packet = subagentStart("a1", "general-purpose");
    expect(packet).toContain("packages/cli has no auth");
    expect(events().find((event) => event.ev === "SubagentStart")).toMatchObject({ scope: "parent" });
  });

  test("a launch older than 5 s is another's: the parent's recent paths instead", () => {
    plant();
    readBatch("packages/cli/src/index.ts", "p1");
    launch("look at apps/web/app/login.ts", "Explore");
    tick(6_000);
    const packet = subagentStart("a1", "Explore");
    expect(packet).toContain("packages/cli has no auth");
    expect(packet).not.toContain("Clerk");
  });

  test("a resumed subagent keeps its stored scope and takes no other launch", () => {
    plant();
    launch("look at apps/web/app/login.ts", "Explore");
    expect(subagentStart("a1", "Explore")).toContain("Clerk");
    launch("look at packages/cli/src/index.ts", "Explore");
    expect(subagentStart("a1", "Explore")).toBe("");
    expect(subagentStart("a2", "Explore")).toContain("packages/cli has no auth");
  });

  test("its wide event names the point, where its scope came from and what it delivered", () => {
    plant();
    launch("fix the redirect in apps/web/app/login.ts", "general-purpose");
    subagentStart("a1", "general-purpose");
    const event = events().find((e) => e.ev === "SubagentStart");
    expect(event).toMatchObject({ point: "deliver.subagent", mode: "on", scope: "task", win: `${PARENT}--a1` });
    expect((event?.cids as string[]).length).toBe(1);
  });
});

describe("SubagentStart: policies by the task's and the type's classes (A4 §5.3)", () => {
  test("a task that names a merge gets the merge rule", () => {
    plant();
    launch("merge the dependabot PR once CI is green", "general-purpose");
    expect(subagentStart("a1", "general-purpose")).toContain("Rule you set: Don't merge PRs yourself");
  });

  test("a reviewer gets it whatever its task", () => {
    plant();
    launch("look over the diff in packages/cli/src/index.ts", "code-reviewer");
    expect(subagentStart("a1", "code-reviewer")).toContain("Don't merge PRs yourself");
  });

  test("a subagent whose type and task name no class does not", () => {
    plant();
    launch("look at apps/web/app/login.ts", "Explore");
    expect(subagentStart("a1", "Explore")).not.toContain("merge");
  });

  test("at most 3 bullets", () => {
    plant([
      CLERK,
      "In apps/web the database is Postgres.",
      "In apps/web the cache is Redis.",
      "In apps/web the queue is SQS.",
      "In apps/web the test runner is Vitest.",
      NO_MERGE,
    ]);
    launch("merge the PR after fixing apps/web/app/login.ts", "general-purpose");
    const packet = subagentStart("a1", "general-purpose");
    expect(packet).toContain("Don't merge PRs yourself");
    expect(bullets(packet).length).toBe(3);
  });
});

describe("SubagentStart: a fork, a child's shadow set, its transcript (D25, D27)", () => {
  test("a fork gets nothing its parent's conversation says, however far back (D26); a typed subagent does", () => {
    plant();
    const line = (type: string, text: string) =>
      JSON.stringify({ type, message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
    const turns = [
      line("user", CLI_AUTH),
      line("assistant", "Noted."),
      ...["list the open issues", "check the deploy queue", "run the linter"].flatMap((text) => [
        line("user", text),
        line("assistant", "Done."),
      ]),
    ];
    writeFileSync(transcript(PARENT), `${turns.join("\n")}\n`);
    launch("carry on with packages/cli/src/index.ts", "fork");
    expect(subagentStart("a-fork", "fork")).not.toContain("packages/cli has no auth");
    launch("carry on with packages/cli/src/index.ts", "general-purpose");
    expect(subagentStart("a-typed", "general-purpose")).toContain("packages/cli has no auth");
  });

  test("a fork gets nothing its parent's ledger holds; a typed subagent with the same task does", () => {
    plant();
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "on";
    expect(submit("how does packages/cli authenticate?", "p1")).toContain("packages/cli has no auth");
    launch("carry on with packages/cli/src/index.ts", "fork");
    expect(subagentStart("a-fork", "fork")).not.toContain("packages/cli has no auth");
    launch("carry on with packages/cli/src/index.ts", "general-purpose");
    expect(subagentStart("a-typed", "general-purpose")).toContain("packages/cli has no auth");
  });

  test("a fork's window copies the parent's deliveries once, at its first start", () => {
    plant();
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "on";
    submit("how does packages/cli authenticate?", "p1");
    subagentStart("a-fork", "fork");
    const copied = readLedger(childWindow("a-fork")).delivered.size;
    expect(copied).toBeGreaterThan(0);
    subagentStart("a-fork", "fork");
    expect(readLedger(childWindow("a-fork")).delivered.size).toBe(copied);
  });

  test("an instruction file the parent loaded: in a general-purpose child's set and a fork's, not an Explore's", () => {
    plant([CLERK]);
    writeFileSync(join(project, "CLAUDE.md"), "# Notes\n\nIn apps/web the auth provider is Clerk.\n");
    memoryHookResponse({
      session_id: PARENT,
      cwd: project,
      transcript_path: transcript(PARENT),
      hook_event_name: "InstructionsLoaded",
      file_path: join(project, "CLAUDE.md"),
      memory_type: "Project",
      load_reason: "session_start",
    });
    const task = "look at apps/web/app/login.ts";
    for (const [agent, type, briefed] of [
      ["a1", "general-purpose", false],
      ["a2", "fork", false],
      ["a3", "Explore", true],
      ["a4", "Plan", true],
    ] as const) {
      launch(task, type);
      expect(subagentStart(agent, type).includes("Clerk")).toBe(briefed);
    }
  });

  test("its deliveries are measured on its own transcript, not the session's", () => {
    plant();
    writeFileSync(transcript(PARENT), "x".repeat(50_000));
    mkdirSync(join(dir, "projects", PARENT, "subagents"), { recursive: true });
    writeFileSync(childTranscriptOf("a1"), "y".repeat(1_234));
    launch("fix the redirect in apps/web/app/login.ts", "general-purpose");
    subagentStart("a1", "general-purpose");
    const offs = [...readLedger(childWindow("a1")).delivered.values()].map((entry) => entry.off);
    expect(offs).toEqual([1_234]);
  });
});

describe("SubagentStart under its flag (X7) and consent", () => {
  test("off: nothing printed, nothing written for the child", () => {
    plant();
    process.env.EDEN_FLAG_DELIVER_SUBAGENT = "off";
    expect(subagentStart("a1", "general-purpose")).toBe("");
    expect(existsSync(childWindow("a1"))).toBe(false);
  });

  test("shadow (the default): nothing printed; the shadow ledger only", () => {
    plant();
    delete process.env.EDEN_FLAG_DELIVER_SUBAGENT;
    launch("fix the redirect in apps/web/app/login.ts", "general-purpose");
    expect(subagentStart("a1", "general-purpose")).toBe("");
    expect(readLedger(childWindow("a1"), "delivery.shadow.log").delivered.size).toBe(1);
    expect(existsSync(join(childWindow("a1"), "delivery.log"))).toBe(false);
  });

  test("read-only consent: the packet, and nothing written", () => {
    plant();
    launch("fix the redirect in apps/web/app/login.ts", "general-purpose");
    process.env.EDEN_MEMORY = "readonly";
    expect(subagentStart("a1", "general-purpose")).toContain("Clerk");
    expect(existsSync(childWindow("a1"))).toBe(false);
    expect(readFileSync(join(windows(), PARENT, "spawn.log"), "utf8")).not.toContain('"take"');
  });

  test("a torn spawn log fails open", () => {
    plant();
    mkdirSync(join(windows(), PARENT), { recursive: true });
    writeFileSync(join(windows(), PARENT, "spawn.log"), "{not json\n");
    expect(() => subagentStart("a1", "general-purpose")).not.toThrow();
  });
});
