/**
 * P1.2 at the hook (A4 §4 "Re-arm", §5.2; D25 epochs; R0 F5, F14, F32): PostCompact re-arms only what
 * `compact_summary` dropped, `clear` starts an epoch, a fork brings nothing at its SessionStart and copies the
 * parent's ledger, and the internal compaction agent's SubagentStop writes nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_HOOK_EVENTS } from "./doctor";
import { respondToHook } from "./hook";
import { memoryHookResponse, type HookStage } from "./memory-hook";
import { installedHooks } from "./setup";

const SESSION = "s-epochs";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const FACT = "The database is postgres.";
const RULE = "Don't merge PRs yourself.";
const FACT_CUE = "what database do we use?";
const RULE_CUE = "merge the PRs once CI passes";

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
  dir = mkdtempSync(join(tmpdir(), "eden-hook-epochs-"));
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

function hook(fields: Record<string, unknown>, stage?: HookStage): Record<string, unknown> | null {
  return memoryHookResponse({ session_id: SESSION, ...fields }, stage);
}

function packetOf(out: Record<string, unknown> | null): string {
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

function submit(prompt: string, promptId: string, fields: Record<string, unknown> = {}): string {
  return packetOf(hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId, ...fields }));
}

/** A compaction as Claude Code runs it after the internal agent's SubagentStop (R0 F32). */
function compact(summary: string, fields: Record<string, unknown> = {}): void {
  hook({ hook_event_name: "SessionStart", source: "compact", ...fields });
  hook({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: summary, ...fields });
}

type Wide = Record<string, unknown> & { ev: string };

function lastEvent(ev: string): Wide | undefined {
  const events = join(dir, "memory", "hook.log.d");
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Wide)
    .findLast((event) => event.ev === ev);
}

/** Every file under a directory, with its text. */
function filesUnder(root: string): { path: string; text: string }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/** Gives the window the fact and the rule, then answers one cue of each. */
function deliverBoth(): void {
  submit(FACT, "p1");
  submit(RULE, "p2");
  expect(submit(FACT_CUE, "p3")).toContain("postgres");
  expect(submit(RULE_CUE, "p4")).toContain("merge PRs yourself");
}

describe("A4 §4: PostCompact re-arms only what compact_summary dropped (R0 F14)", () => {
  test("a summary that keeps the fact and drops the rule: the fact stays habituated, the rule comes back", () => {
    deliverBoth();
    compact("The database is postgres. The user asked about CI timing.");
    expect(submit(FACT_CUE, "p5")).not.toContain("postgres");
    expect(submit(RULE_CUE, "p6")).toContain("merge PRs yourself");
  });

  test("a summary that keeps the rule (its class verb and object) and drops the fact: the reverse", () => {
    deliverBoth();
    compact("The user asked Claude not to be merging PRs on its own. CI timing was discussed.");
    expect(submit(RULE_CUE, "p5")).not.toContain("merge PRs yourself");
    expect(submit(FACT_CUE, "p6")).toContain("postgres");
  });

  test("PostCompact's wide event names the cids the summary held; the window keeps no summary text (X11)", () => {
    deliverBoth();
    compact("The database is postgres. The user asked about CI timing.");
    const event = lastEvent("PostCompact");
    expect(event?.held).toHaveLength(1);
    expect(event?.rearmed).toBe(1);
    const window = filesUnder(join(dir, "memory", "windows"));
    expect(window.length).toBeGreaterThan(0);
    expect(window.filter((file) => /timing/i.test(file.text)).map((file) => file.path)).toEqual([]);
  });

  test("with every point in shadow, PostCompact holds in the shadow ledger, by its own epochs", () => {
    process.env.EDEN_FLAG_DELIVER_SUBMIT = "shadow";
    process.env.EDEN_FLAG_DELIVER_SESSION_START = "shadow";
    submit(FACT, "p1");
    submit(FACT_CUE, "p2");
    compact("The database is postgres.");
    submit(FACT_CUE, "p3");
    const cids = (lastEvent("UserPromptSubmit")?.cids as string[] | undefined) ?? [];
    expect(cids).toEqual([]);
    expect(lastEvent("PostCompact")?.held).toHaveLength(1);
  });
});

describe("A4 §4: SessionStart(clear) starts an epoch", () => {
  test("a host that keeps the session id across /clear re-arms what the window was given", () => {
    submit(FACT, "p1");
    expect(submit(FACT_CUE, "p2")).toContain("postgres");
    expect(submit(FACT_CUE, "p3")).not.toContain("postgres");
    hook({ hook_event_name: "SessionStart", source: "clear" });
    expect(submit(FACT_CUE, "p4")).toContain("postgres");
  });
});

describe("R0 F32: the internal compaction agent's SubagentStop", () => {
  test("agent_type '' (no transcript of its own) writes nothing under the memory root", () => {
    submit(FACT, "p1");
    hook(
      {
        hook_event_name: "SubagentStop",
        agent_id: "a0123456789abcdef",
        agent_type: "",
        last_assistant_message: "Summary: the quokka ledger was reconciled.",
      },
      undefined,
    );
    const written = filesUnder(join(dir, "memory")).filter((file) => file.text.includes("quokka"));
    expect(written.map((file) => file.path)).toEqual([]);
  });
});

describe("A4 §4: a fork copies the parent's ledger (D25)", () => {
  const PARENT = "s-parent";
  const FORK = "s-fork";
  const projects = () => join(dir, "projects");
  const transcriptOf = (session: string) => join(projects(), `${session}.jsonl`);
  type Line = Record<string, unknown>;
  const at = (second: number) => new Date(NOW - 600_000 + second * 1000).toISOString();
  const typed = (uuid: string, parentUuid: string | null, promptId: string, text: string, second: number): Line => ({
    parentUuid,
    promptId,
    type: "user",
    message: { role: "user", content: text },
    uuid,
    timestamp: at(second),
    origin: { kind: "human" },
  });
  const said = (uuid: string, parentUuid: string, text: string, second: number): Line => ({
    parentUuid,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    uuid,
    timestamp: at(second),
  });
  const write = (session: string, ...lines: Line[]) => {
    mkdirSync(projects(), { recursive: true });
    appendFileSync(transcriptOf(session), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  };
  const as = (session: string) => ({ session_id: session, transcript_path: transcriptOf(session) });
  const stopSleep = (session: string, last: string) =>
    hook({ hook_event_name: "Stop", last_assistant_message: last, ...as(session) }, "stop-sleep");

  /**
   * The parent's turns: the fact and its cue before the fork point (u2), the rule and its cue after it (u4). Two
   * other prompts come between each statement and its cue, so D26's residual (the last 2 typed prompts) does not hold
   * the statement.
   */
  function parentTurns(): Line[] {
    const lines = [
      typed("u1", null, "p1", FACT, 1),
      said("a1", "u1", "Noted.", 2),
      typed("ux", "a1", "px", "list the open issues", 2),
      said("ax", "ux", "There are none.", 2),
      typed("uy", "ax", "py", "check the deploy queue", 2),
      said("ay", "uy", "It is empty.", 2),
      typed("u2", "ay", "p2", FACT_CUE, 3),
      said("a2", "u2", "Postgres.", 4),
    ];
    submit(FACT, "p1", as(PARENT));
    write(PARENT, ...lines.slice(0, 6));
    expect(submit(FACT_CUE, "p2", as(PARENT))).toContain("postgres");
    write(PARENT, ...lines.slice(6));
    stopSleep(PARENT, "Postgres.");
    submit(RULE, "p3", as(PARENT));
    write(
      PARENT,
      typed("u3", "a2", "p3", RULE, 5),
      said("a3", "u3", "Understood.", 6),
      typed("uz", "a3", "pz", "list the open issues", 6),
      said("az", "uz", "There are none.", 6),
      typed("uw", "az", "pw", "check the deploy queue", 6),
      said("aw", "uw", "It is empty.", 6),
    );
    expect(submit(RULE_CUE, "p4", as(PARENT))).toContain("merge PRs yourself");
    write(PARENT, typed("u4", "aw", "p4", RULE_CUE, 7), said("a4", "u4", "I will leave the merge to you.", 8));
    stopSleep(PARENT, "I will leave the merge to you.");
    return lines;
  }

  test("SessionStart(fork) brings nothing new: the fork holds the parent's context, packets included", () => {
    parentTurns();
    const fork = hook({ hook_event_name: "SessionStart", source: "fork", seconds_since_last_response: 5, ...as(FORK) });
    expect(fork).toBeNull();
    // Since P2.5 a startup briefs pins only, and the parent's rule, said once, is none: the gist that a compaction's
    // SessionStart still briefs shows what the fork was not given.
    const compacted = hook({ hook_event_name: "SessionStart", source: "compact", ...as("s-fresh") });
    expect(packetOf(compacted)).not.toBe("");
  });

  test("after the fork's first turn, its ledger holds the parent's deliveries from before the fork point only", () => {
    const copied = parentTurns();
    hook({ hook_event_name: "SessionStart", source: "fork", seconds_since_last_response: 5, ...as(FORK) });
    // Claude Code writes the fork's transcript after its first turn: the parent's lines up to the fork point, with
    // their uuids and the fork's promptId, then the fork's own turn.
    submit("check the deploy logs", "pf1", as(FORK));
    write(FORK, ...copied.map((line) => (line.promptId ? { ...line, promptId: "pf1" } : line)));
    write(FORK, typed("uf1", "a2", "pf1", "check the deploy logs", 9), said("af1", "uf1", "The logs are clean.", 10));
    stopSleep(FORK, "The logs are clean.");
    expect(submit(FACT_CUE, "pf2", as(FORK))).not.toContain("postgres");
    expect(submit(RULE_CUE, "pf3", as(FORK))).toContain("merge PRs yourself");
  });

  test("the fork's first delta encodes only its own lines, not the parent's copied ones again (P1.3)", () => {
    const copied = parentTurns();
    hook({ hook_event_name: "SessionStart", source: "fork", seconds_since_last_response: 5, ...as(FORK) });
    submit("check the deploy logs", "pf1", as(FORK));
    write(FORK, ...copied.map((line) => (line.promptId ? { ...line, promptId: "pf1" } : line)));
    write(FORK, typed("uf1", "a2", "pf1", "check the deploy logs", 9), said("af1", "uf1", "The logs are clean.", 10));
    stopSleep(FORK, "The logs are clean.");
    // The copied assistant lines (a1 to a2) were the parent's, which its own delta encoded; af1 is the fork's.
    expect(lastEvent("Stop")?.encoded).toBe(1);
    expect(lastEvent("Stop")?.forked_from).toBe(PARENT);
  });
});

describe("PostCompact reaches the memory hook", () => {
  test("the plugin and `eden setup` register PostCompact, and doctor checks for it", () => {
    const plugin = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../plugins/eden-memory/hooks/hooks.json"), "utf8"),
    ) as { hooks?: Record<string, unknown> };
    expect(plugin.hooks?.PostCompact).toBeTruthy();
    expect(installedHooks("curl …")).toHaveProperty("PostCompact");
    expect(MEMORY_HOOK_EVENTS as readonly string[]).toContain("PostCompact");
  });

  test("`eden hook` (respondToHook) passes PostCompact to the memory hook", async () => {
    deliverBoth();
    hook({ hook_event_name: "SessionStart", source: "compact" });
    await respondToHook({ hook_event_name: "PostCompact", session_id: SESSION, compact_summary: FACT });
    expect(submit(FACT_CUE, "p5")).not.toContain("postgres");
  });
});
