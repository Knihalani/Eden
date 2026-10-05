/**
 * P0.2 at the hook: which submits get a packet (D24, A7 §2), the human-turn counter (A4 §4), and the packet's shape
 * and wording (D28, D14).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Every file under the memory root, as one string. */
function storeText(): string {
  const root = join(dir, "memory");
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
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
  });

  test("a prompt equal to a cron of the window's last Stop is non-human; the cron text is kept only as a hash", () => {
    submit("Kai's timezone is Pacific", { prompt_id: "p1" });
    stop({ session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "ping Kai about Pacific" }] });
    expect(submit("ping Kai about Pacific", { prompt_id: "p2" })).toBeUndefined();
    expect(humanTurns()).toBe(1);
    expect(windowFile("ctx.log")).not.toContain("ping Kai");
    stop({ session_crons: [] });
    expect(submit("ping Kai about Pacific", { prompt_id: "p3" })).toContain("Pacific");
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
  test("a packet is worded as project information, with where each bullet came from", () => {
    submit("Kai's timezone is Pacific", { prompt_id: "p1" });
    const packet = submit("What time should I ping Kai about the release?", { prompt_id: "p2" }) ?? "";
    expect(packet.startsWith(`${HEADER}\n- `)).toBe(true);
    // Ages need persisted times (P0.3); until then a bullet may say only where it came from.
    expect(packet).toMatch(/Pacific.* \(you said(?:, [^)]+)?\)$/m);
    expect(packet).not.toMatch(/\[(?:fact|episode|rule|gist|procedure)\b/);
  });

  test("a rule reads 'Rule you set: …' at SessionStart", () => {
    submit("Never commit .env or credentials.json", { prompt_id: "p1" });
    const out = memoryHookResponse({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup" });
    const packet = (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "";
    expect(packet).toStartWith(HEADER);
    expect(packet).toContain("- Rule you set: Never commit .env or credentials.json");
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
