/**
 * Product-contract guards for the real-use harness.
 * Freeze hook omit/off/fail-open and the anti-dump scorer — not helper names.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";
import {
  dumpOraclePacket,
  fatPrompt,
  packetText,
  scorePacket,
  selectiveOraclePacket,
  sessionTurns,
} from "./score";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eden-contract-"));
}

function withDir<T>(fn: (dir: string) => T, extra: Record<string, string | undefined> = {}): T {
  const dir = tmp();
  const keys = ["EDEN_MEMORY_DIR", "EDEN_MEMORY", "EDEN_KNOW", "EDEN_HOME", "EDEN_MEMORY_X", "EDEN_MEMORY_MIN"];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    process.env.EDEN_MEMORY_DIR = dir;
    process.env.EDEN_MEMORY = extra.EDEN_MEMORY ?? "on";
    process.env.EDEN_KNOW = "0";
    delete process.env.EDEN_HOME;
    delete process.env.EDEN_MEMORY_X;
    delete process.env.EDEN_MEMORY_MIN;
    return fn(dir);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("scorer anti-game", () => {
  test("dump of golds plus qx distractors is a miss while gold_only stays true", () => {
    const blob = dumpOraclePacket(["Clerk", "sqlite"]);
    const s = scorePacket(blob, ["Clerk", "sqlite"]);
    expect(s.goldOnly).toBe(true);
    expect(s.hit).toBe(false);
  });

  test("hand-built 1–3 line packet hits", () => {
    const blob = selectiveOraclePacket(["Clerk"]);
    const s = scorePacket(blob, ["Clerk"]);
    expect(s.hit).toBe(true);
  });

  test("stale overwrite is a miss", () => {
    const blob = "Eden Memory:\n- The database is postgres.";
    expect(scorePacket(blob, ["sqlite"], ["postgres"]).hit).toBe(false);
  });

  test("qx in an otherwise gold packet is a miss", () => {
    const blob = "Eden Memory:\n- Auth is Clerk.\n- spare bin is qx9z leftover.";
    expect(scorePacket(blob, ["Clerk"]).hit).toBe(false);
    expect(scorePacket(blob, ["Clerk"]).reason).toBe("qx");
  });
});

describe("hook contracts", () => {
  test("math cue on a loaded store omits the packet", () => {
    withDir(() => {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: [{ role: "user", content: "Auth is Clerk." }],
      });
      const blob = packetText(
        memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what's 17 times 23?" }),
      );
      expect(blob).not.toContain("Eden Memory:");
      expect(blob).not.toMatch(/Clerk/i);
    });
  });

  test("math still omits after a 48-turn observed thread", () => {
    withDir(() => {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: sessionTurns(1, "Auth is Clerk."),
      });
      const blob = packetText(
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: fatPrompt("what's 17 times 23?", "para"),
        }),
      );
      expect(blob).not.toContain("Eden Memory:");
      expect(blob).not.toMatch(/Clerk/i);
    });
  });

  test("tight paste after 48-turn buried gold still injects Clerk", () => {
    withDir(() => {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: sessionTurns(1, "Auth is Clerk."),
      });
      const blob = packetText(
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          prompt: fatPrompt("why is login broken?", "tight"),
        }),
      );
      expect(blob).toContain("Eden Memory:");
      expect(blob).toMatch(/Clerk/i);
    });
  });

  test("thanks omits the packet", () => {
    withDir(() => {
      memoryHookResponse({
        hook_event_name: "Stop",
        messages: [{ role: "user", content: "Auth is Clerk." }],
      });
      const blob = packetText(memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "thanks" }));
      expect(blob).not.toContain("Eden Memory:");
    });
  });

  test("EDEN_MEMORY=0 yields no packet", () => {
    withDir(() => {
      const blob = packetText(
        memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "where is the nonce field kept?" }),
      );
      expect(blob).toBe("");
    }, { EDEN_MEMORY: "0" });
  });

  test("torn memories.jsonl fail-open: hook does not throw", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "memories.jsonl"), "{");
      expect(() =>
        memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what database do we use?" }),
      ).not.toThrow();
      void dir;
    });
  });

  test("session subdir torn file fail-open", () => {
    withDir((dir) => {
      const sub = join(dir, "s-torn");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "memories.jsonl"), "{");
      expect(() =>
        memoryHookResponse({
          hook_event_name: "UserPromptSubmit",
          session_id: "s-torn",
          prompt: "hello",
        }),
      ).not.toThrow();
    });
  });
});
