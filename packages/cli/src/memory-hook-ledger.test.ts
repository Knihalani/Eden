/**
 * P1.1 at the hook (A4 §4, §5.1 step 9; D25): `stop-sleep` folds the window's ledger into its snapshot, the Submit
 * reads snapshot + log, past 6k tokens in an epoch only `Updated:` items go out, a changed value comes back as an
 * `Updated:` item, and the wide event logs the transcript's bytes beside `message.usage`'s context tokens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EPOCH_TOKEN_CAP, readLedger, recordPacket } from "../../../src/memory-ledger";
import { memoryHookResponse } from "./memory-hook";

const SESSION = "s-ledger";
const RULE = "we use pnpm in this repo, never npm";
const CUE = "install the dependencies with npm";
const NOW = Date.parse("2026-10-10T12:00:00Z");

let dir = "";
const ENV_KEYS = ["EDEN_MEMORY_DIR", "EDEN_HOME", "EDEN_MEMORY", "EDEN_NOW", "EDEN_FLAG_DELIVER_SUBMIT"] as const;
const prev = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-hook-ledger-"));
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

const win = () => join(dir, "memory", "windows", SESSION);

function submit(prompt: string, extra: Record<string, unknown> = {}): string | undefined {
  const out = memoryHookResponse({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt, ...extra });
  return (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
}

type Wide = Record<string, unknown> & { ev: string };

function lastSubmitEvent(): Wide {
  const events = join(dir, "memory", "hook.log.d");
  return readdirSync(events)
    .sort()
    .flatMap((name) => readFileSync(join(events, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as Wide)
    .findLast((event) => event.ev === "UserPromptSubmit")!;
}

describe("D25: stop-sleep folds the ledger", () => {
  test("delivery.json is written and the log rotated away; the next Submit still holds what was delivered", () => {
    submit(RULE);
    expect(submit(CUE)).toContain(RULE);
    memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION, last_assistant_message: "Done." }, "stop-sleep");
    expect(existsSync(join(win(), "delivery.json"))).toBe(true);
    const log = join(win(), "delivery.log");
    expect(existsSync(log) ? statSync(log).size : 0).toBe(0);
    expect(submit(CUE, { prompt_id: "p-after-fold" })).toBeUndefined();
    expect(lastSubmitEvent()).toMatchObject({ hturn: 3 });
    expect((lastSubmitEvent().drops as Record<string, number>).refractory).toBeGreaterThan(0);
  });
});

describe("A4 §4: cids and the budget", () => {
  test("the ledger's and the event's cids carry the repo's first 8 hex characters", () => {
    submit(RULE);
    submit(CUE);
    const event = lastSubmitEvent();
    const repo8 = String(event.repo).slice(0, 8);
    expect(event.cids).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${repo8}/`))]));
    expect([...readLedger(win()).delivered.keys()].every((cid) => cid.startsWith(`${repo8}/`))).toBe(true);
  });

  test("past 6k tokens in the epoch the cue gets no packet, and the drop is the budget's", () => {
    submit(RULE);
    recordPacket(win(), { keys: [], tokens: EPOCH_TOKEN_CAP }, { off: 0, att: "p-filler", ht: 1 });
    expect(submit(CUE)).toBeUndefined();
    const event = lastSubmitEvent();
    expect((event.drops as Record<string, number>).budget).toBeGreaterThan(0);
    expect(event.tokens_epoch).toBeGreaterThanOrEqual(EPOCH_TOKEN_CAP);
  });
});

describe("A4 §4: Updated items", () => {
  test("after a switch, the cue that was given the old value gets the new one as an Updated item", () => {
    submit("Our auth provider is Auth0.");
    expect(submit("which auth provider do we use?", { prompt_id: "p-q1" })).toContain("Auth0");
    submit("We switched auth from Auth0 to Clerk.", { prompt_id: "p-switch" });
    submit("format the code", { prompt_id: "p-f1" });
    submit("run the linter", { prompt_id: "p-f2" });
    const packet = submit("which auth provider do we use?", { prompt_id: "p-q2" });
    expect(packet).toMatch(/\n- Updated: [^\n]*Clerk/);
    expect(packet).not.toMatch(/\n- (?!Updated)[^\n]*Auth0/);
  });
});

describe("A5 re-eligibility: bytes and message.usage side by side", () => {
  test("the Submit's event logs the transcript's size, the context tokens of its last usage, and the row ids", () => {
    const transcript = join(dir, "t.jsonl");
    const usage = { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 };
    writeFileSync(
      transcript,
      `${[
        { type: "user", uuid: "u1", message: { role: "user", content: RULE } },
        {
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: [{ type: "text", text: "Ok." }], usage },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    submit(RULE, { transcript_path: transcript });
    submit(CUE, { transcript_path: transcript, prompt_id: "p-cue" });
    const event = lastSubmitEvent();
    expect(event).toMatchObject({ off: statSync(transcript).size, ctx_tokens: 4312 });
    expect((event.ids as string[]).length).toBe((event.cids as string[]).length);
  });
});
