/**
 * P0.2 at the hook: which submits get a packet (D24, A7 §2), the human-turn counter (A4 §4), the packet's shape
 * and wording (D28, D14), and what is no longer delivered: an invalidated value or rule (A4 §3.1, §5.1 step 5) and
 * what the last turns already say (D26).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeFor } from "../../../src/memory-repo";
import { memoryHookResponse } from "./memory-hook";

const HEADER = "Eden memory, recalled from earlier sessions:";
const SESSION = "s-turns";

let dir = "";
const prev = { dir: process.env.EDEN_MEMORY_DIR, home: process.env.EDEN_HOME, memory: process.env.EDEN_MEMORY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-turns-"));
  process.env.EDEN_MEMORY_DIR = join(dir, "memory");
  process.env.EDEN_HOME = join(dir, "home");
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["EDEN_MEMORY_DIR", prev.dir],
    ["EDEN_HOME", prev.home],
    ["EDEN_MEMORY", prev.memory],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A transcript whose last assistant message is `assistant`. */
function transcript(assistant: string): string {
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = [
    { type: "user", message: { role: "user", content: "look at the setup" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistant }] } },
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function submit(prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt, ...extra });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

function stop(extra: Record<string, unknown> = {}): void {
  memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION, last_assistant_message: "Done.", ...extra });
}

function windowFile(name: string): string {
  const path = join(dir, "memory", "windows", SESSION, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** `hturn` as A4 §4 defines it: distinct `prompt_id`s among the window's `turn` records. */
function humanTurns(): number {
  const records = windowFile("delivery.log")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { k: string; prompt_id: string });
  return new Set(records.filter((record) => record.k === "turn").map((record) => record.prompt_id)).size;
}

/** Every file under the memory root, or (`logs`) only the wide events of `hook.log.d/` (P0.8), which name rules. */
function storeText(logs = false): string {
  const root = join(dir, "memory");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.parentPath.includes("hook.log.d") === logs)
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

describe("D24: non-human submits are silent and do not count as turns", () => {
  test("a task notification, an agent message or a peer message gets no packet, and its text is not stored", () => {
    submit("Kai's timezone is Pacific", { prompt_id: "p1" });
    expect(submit("What time should I ping Kai about the release?", { prompt_id: "p2" })).toContain("Pacific");
    const notification =
      "<task-notification>\n<task-id>b7</task-id>\n<summary>Ping Kai about the Pacific release</summary>\n</task-notification>";
    expect(submit(notification, { prompt_id: "p3" })).toBeUndefined();
    expect(submit('<agent-message from="a1">ping Kai about the Pacific release</agent-message>')).toBeUndefined();
    const peer =
      'Another Claude session sent a message:\n<agent-message from="a2">ping Kai, Pacific time</agent-message>';
    expect(submit(peer)).toBeUndefined();
    expect(submit("  <teammate-message>Kai is on Pacific time</teammate-message>")).toBeUndefined();
    expect(submit("<cross-session-message>when is Kai online?</cross-session-message>")).toBeUndefined();
    expect(humanTurns()).toBe(2);
    expect(storeText()).not.toContain("task-notification");
    expect(storeText()).not.toContain("agent-message");
    for (const word of ["Pacific", "ping", "release", "online"]) expect(storeText(true)).not.toContain(word);
  });

  test("a prompt equal to a cron of the window's last Stop is non-human; the cron text is kept only as a hash", () => {
    submit("Kai's timezone is Pacific", { prompt_id: "p1" });
    stop({
      session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "ping Kai about the release" }],
    });
    expect(submit("ping Kai about the release", { prompt_id: "p2" })).toBeUndefined();
    expect(humanTurns()).toBe(1);
    expect(windowFile("ctx.log")).not.toContain("ping Kai");
    stop({ session_crons: [] });
    // Human again once the cron is gone. The prompt must not state the value itself, which D26 would drop.
    expect(submit("ping Kai about the release", { prompt_id: "p3" })).toContain("Pacific");
    expect(humanTurns()).toBe(2);
  });
});

describe("A7 §2: ack and continuation turns are silent until the situation cue (P4.1)", () => {
  test("an ack after a report gets no packet, but counts as a human turn", () => {
    submit("Great care is needed with the payments migration.", { prompt_id: "p1" });
    const report = transcript("I checked the setup: all 42 tests pass and nothing needs changing.");
    expect(submit("great", { prompt_id: "p2", transcript_path: report })).toBeUndefined();
    expect(submit("continue", { prompt_id: "p3", transcript_path: report })).toBeUndefined();
    expect(humanTurns()).toBe(3);
  });

  test("'yes, do it' and a short reply after a proposal get no packet", () => {
    submit("Yes, the staging replica runs postgres 15.", { prompt_id: "p1" });
    const proposal = transcript("I can migrate the staging database next. Shall I go ahead?");
    expect(submit("yes do it", { prompt_id: "p2", transcript_path: proposal })).toBeUndefined();
    expect(submit("use the replica", { prompt_id: "p3", transcript_path: proposal })).toBeUndefined();
    expect(humanTurns()).toBe(3);
  });

  test("an unanswered reply to a proposal is still stored, so a later prompt can recall it (A4 §5.1 step 1)", () => {
    const proposal = transcript("I can set up the package scripts next. Should I use npm?");
    expect(submit("zebrapkg uses pnpm", { prompt_id: "p1", transcript_path: proposal })).toBeUndefined();
    expect(submit("which package manager does zebrapkg use?", { prompt_id: "p2" })).toContain("pnpm");
  });

  test("the same short reply after a report is an ordinary prompt", () => {
    submit("Yes, the staging replica runs postgres 15.", { prompt_id: "p1" });
    const report = transcript("The staging database is migrated.");
    expect(submit("use the replica", { prompt_id: "p2", transcript_path: report })).toContain("replica");
  });
});

describe("A4 §4: the human-turn counter", () => {
  test("two Submits of one prompt_id count once", () => {
    submit("first prompt about the release", { prompt_id: "p1" });
    submit("first prompt about the release", { prompt_id: "p1" });
    submit("second prompt about the release", { prompt_id: "p2" });
    expect(humanTurns()).toBe(2);
  });

  test("readonly writes no turn record", () => {
    process.env.EDEN_MEMORY = "readonly";
    submit("a prompt about the release", { prompt_id: "p1" });
    expect(humanTurns()).toBe(0);
  });
});

describe("D14, D28: the packet's wording and shape", () => {
  // A bullet claims the source its row records (A6 §2.1): since P0.4 the user's own rows record `src:user`.
  test("a packet is worded as project information, with no tag and the authority its row shows", () => {
    submit("Kai's timezone is Pacific", { prompt_id: "p1" });
    const packet = submit("What time should I ping Kai about the release?", { prompt_id: "p2" }) ?? "";
    expect(packet.startsWith(`${HEADER}\n- `)).toBe(true);
    expect(packet).toMatch(/^- Kai's timezone is Pacific \(you said, just now\)$/m);
    expect(packet).not.toMatch(/\[(?:fact|episode|rule|gist|procedure)\b/);
  });

  test("a rule without a source is a plain bullet at SessionStart", () => {
    // A row written before P0.4 records no source. Payloads without a cwd are the test process's repo (D1).
    const legacy = { id: "r1", text: "Never commit .env or credentials.json", kind: "constraint", tags: ["pin"] };
    const store = storeFor(join(dir, "memory"));
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "memories.jsonl"), JSON.stringify({ ...legacy, t: Date.now() }) + "\n");
    const out = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup" });
    const packet = (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(packet).toStartWith(HEADER);
    expect(packet).toContain("- Never commit .env or credentials.json");
    expect(packet).not.toMatch(/Rule you set|Rule on record/);
  });

  test("bullets are not filled to a fixed count: at most 4, at most 2 episodes, within 900 bytes", () => {
    for (let n = 1; n <= 8; n++) submit(`zebra migration step ${n} touched the billing tables`, { prompt_id: `p${n}` });
    const packet = submit("what did the zebra migration change?", { prompt_id: "p9" }) ?? "";
    const bullets = packet.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(0);
    expect(bullets.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(packet, "utf8")).toBeLessThanOrEqual(900);
  });
});

function sessionStart(session: string): string {
  const out = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session, source: "startup" });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
}

/** A transcript of typed prompts, each answered by the assistant. */
function conversation(prompts: string[]): string {
  const path = join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = prompts.flatMap((text) => [
    { type: "user", message: { role: "user", content: text } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  ]);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

describe("A4 §3.1, §5.1 step 5: an invalidated value or rule is not delivered", () => {
  test("after 'we no longer use …', an older row stating it is dropped at Submit", () => {
    const rearm = () => memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "compact" });
    submit("We use ZebraCache for caching.", { prompt_id: "p1" });
    expect(submit("what is ZebraCache used for?", { prompt_id: "p2" })).toContain("We use ZebraCache");
    // A compaction re-arms the ledger (A4 §4), so only validity can keep the row out.
    rearm();
    expect(submit("what is ZebraCache used for?", { prompt_id: "p3" })).toContain("We use ZebraCache");
    submit("We no longer use ZebraCache.", { prompt_id: "p4" });
    rearm();
    expect(submit("what is ZebraCache used for?", { prompt_id: "p5" }) ?? "").not.toContain("We use ZebraCache");
  });

  test("a retracted value shaped by its capital alone leaves the same English word alone", () => {
    const rearm = () => memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "compact" });
    submit("Make sure the zebra API returns JSON errors with a code field.", { prompt_id: "p1" });
    expect(submit("what should zebra API errors return?", { prompt_id: "p2" })).toContain("Make sure the zebra API");
    submit("We no longer use Make.", { prompt_id: "p3" });
    rearm();
    expect(submit("what should zebra API errors return?", { prompt_id: "p4" })).toContain("Make sure the zebra API");
  });

  test("a lowercase value, a question or another subject retracts nothing", () => {
    const rearm = () => memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "compact" });
    submit("We use ZebraCache for caching.", { prompt_id: "p1" });
    for (const [n, prompt] of [
      "We no longer use zebracache.",
      "Should we drop ZebraCache?",
      "I moved off ZebraCache.",
    ].entries()) {
      submit(prompt, { prompt_id: `q${n}` });
      rearm();
      expect(submit("what is ZebraCache used for?", { prompt_id: `c${n}` })).toContain("We use ZebraCache");
    }
  });

  test("a session gist the sleep rewrites after a retraction is as old as its sources (A4 §3.3)", () => {
    submit("We use ZebraCache for caching.", { prompt_id: "p1" });
    stop();
    expect(sessionStart(SESSION)).toContain("ZebraCache");
    Bun.sleepSync(5);
    submit("We no longer use ZebraCache.", { prompt_id: "p2" });
    Bun.sleepSync(5);
    // The sleep at this Stop writes the session's gist again, after the retraction, from the same older row.
    stop();
    expect(sessionStart(SESSION)).not.toMatch(/uses ZebraCache/i);
  });

  test("so is one the sleep rewrites after a revocation", () => {
    submit("Never merge the zebra PRs yourself.", { prompt_id: "p1" });
    stop();
    expect(sessionStart(SESSION)).toContain("Never merge the zebra PRs yourself");
    Bun.sleepSync(5);
    submit("You can merge the zebra PRs yourself now.", { prompt_id: "p2" });
    Bun.sleepSync(5);
    stop();
    expect(sessionStart(SESSION)).not.toContain("Never merge the zebra PRs yourself");
  });

  test("after 'you can … now', a rule forbidding that action is dropped at SessionStart", () => {
    submit("Never merge the zebra PRs yourself.", { prompt_id: "p1" });
    submit("ok, what is next for the zebra release?", { prompt_id: "p2" });
    expect(sessionStart(SESSION)).toContain("Never merge the zebra PRs yourself");
    submit("You can merge the zebra PRs yourself now.", { prompt_id: "p3" });
    expect(sessionStart(SESSION)).not.toContain("Never merge the zebra PRs yourself");
  });

  test("a permission on another object, or a retraction, leaves a rule in place", () => {
    const cases = [
      ["Never delete the main branch.", "You can delete the branch now."],
      ["Don't push directly to the main branch.", "You can push to the feature branch now."],
      ["Never merge PRs without a review.", "You may merge PR 12 now."],
      ["Never install packages globally.", "You can install the types package now."],
      ["Never drop the production table.", "You can run the tests now."],
      ["Never merge until CI is green.", "We no longer run CI on Fridays."],
      ["Never return GET responses without an ETag.", "Use POST instead of GET for this endpoint."],
      ["Always deploy to AWS from the release branch.", "We no longer use the AWS SDK v2."],
      ["Never flush Redis in production.", "We no longer use Redis."],
    ];
    for (const [n, [rule, said]] of cases.entries()) {
      const session = `${SESSION}-${n}`;
      const ask = (prompt: string, id: string) =>
        memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: session, prompt, prompt_id: id });
      ask(rule!, "p1");
      ask("ok, what is next?", "p2");
      expect(sessionStart(session)).toContain(rule!.replace(/\.$/, ""));
      ask(said!, "p3");
      expect(sessionStart(session)).toContain(rule!.replace(/\.$/, ""));
    }
  });

  test("the validity log keeps no secret a stored row would not", () => {
    submit("You can push with ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Y now. We no longer use AKIAZZZZZZZZZZZZZZZZ.", {
      prompt_id: "p1",
    });
    const store = storeFor(join(dir, "memory"));
    const log = existsSync(join(store, "validity.jsonl")) ? readFileSync(join(store, "validity.jsonl"), "utf8") : "";
    expect(log).toContain('"k":"revoke"');
    expect(log.toLowerCase()).not.toContain("akiazzzzzzzzzzzzzzzz");
    expect(log.toLowerCase()).not.toContain("ab1cd2ef3gh4");
  });
});

describe("D26: what the last turns already say is not delivered", () => {
  test("a row that restates a recent typed prompt is dropped; an older one is not", () => {
    submit("zebra billing runs on the db-replica2 host", { prompt_id: "p1" });
    submit("now fix the lint warnings", { prompt_id: "p2" });
    const recent = conversation(["zebra billing runs on the db-replica2 host", "now fix the lint warnings"]);
    expect(submit("where does zebra billing run?", { prompt_id: "p3", transcript_path: recent }) ?? "").not.toContain(
      "db-replica2",
    );
    const older = conversation([
      "zebra billing runs on the db-replica2 host",
      "rename the export helper",
      "now fix the lint warnings",
    ]);
    expect(submit("where does zebra billing run?", { prompt_id: "p4", transcript_path: older })).toContain(
      "db-replica2",
    );
  });

  test("so is a row that restates a recent prompt of several sentences", () => {
    const said = "We use ZebraCache for caching. The zebra billing service runs on port 4021. Reply with just OK.";
    submit(said, { prompt_id: "p1" });
    // The next submit encodes the transcript, which stores the earlier prompt whole beside its sentences.
    submit("now fix the lint warnings", { prompt_id: "p2", transcript_path: conversation([said]) });
    const recent = conversation([said, "now fix the lint warnings"]);
    expect(submit("Reply with just OK again.", { prompt_id: "p3", transcript_path: recent }) ?? "").not.toContain(
      "port 4021",
    );
  });
});

describe("A4 §4: the ledger's refractory rule", () => {
  const start = (source: string) =>
    (
      memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source })?.hookSpecificOutput as
        { additionalContext?: string } | undefined
    )?.additionalContext;

  test("a bullet is delivered once per window; resume keeps the ledger, a compaction re-arms it", () => {
    submit("zebra billing runs on the db-replica2 host", { prompt_id: "p1" });
    expect(submit("where does zebra billing run?", { prompt_id: "p2" })).toContain("db-replica2");
    expect(submit("where does zebra billing run, again?", { prompt_id: "p3" }) ?? "").not.toContain("db-replica2");
    expect(start("resume")).toBeUndefined();
    expect(submit("where does zebra billing run now?", { prompt_id: "p4" }) ?? "").not.toContain("db-replica2");
    start("compact");
    expect(submit("where does zebra billing run?", { prompt_id: "p5" })).toContain("db-replica2");
    const log = windowFile("delivery.log");
    expect(log).toContain('"k":"deliver"');
    expect(log).toContain('"k":"epoch"');
    expect(log).not.toContain("db-replica2");
  });
});

describe("A4 §3.0, A6 §2.1, A7 §4: text the user did not type", () => {
  test("a tool result is stored with its source and delivered only on A7 §4's evidence", () => {
    const path = join(dir, "tools.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "look at the zebra billing logs" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read" }] } },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "zebra billing worker restarts in billing/worker.ts" },
          ],
        },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ];
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    submit("thanks, that helps", { prompt_id: "p1", transcript_path: path });
    expect(storeText()).toMatch(/zebra billing worker restarts[^\n]*"src:tool"/);
    expect(submit("why does zebra billing stall?", { prompt_id: "p2" }) ?? "").not.toContain("restarts");
    const packet = submit("why does billing/worker.ts restart?", { prompt_id: "p3" }) ?? "";
    expect(packet).toContain("zebra billing worker restarts");
    expect(packet).toContain("(from a tool result");
  });
});
