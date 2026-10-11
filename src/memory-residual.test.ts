import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isResidualNote, legacySlot, recentConversation, residualSentences } from "./memory-residual";

/** A note the residual reads by Jaccard (an episode). */
const episode = (text: string) => ({ id: text, kind: "episode", text });
const isResidual = (text: string, sentences: ReturnType<typeof residualSentences>) =>
  isResidualNote(episode(text), sentences);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const typed = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const said = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolResult = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
});

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-residual-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

describe("D26: the residual", () => {
  test("the current prompt, the last 2 typed prompts and the assistant text between them, newest first", () => {
    const path = transcript([
      typed("The database is postgres."),
      said("Noted."),
      typed("We use Redis for caching."),
      said("Redis it is."),
      toolResult("The cache store is memcached."),
      { type: "user", isMeta: true, message: { role: "user", content: "Caveat: meta text." } },
      typed("<task-notification><task-id>a1</task-id></task-notification>"),
      typed("fix the cache test"),
      said("Done: the cache test passes."),
    ]);
    expect(recentConversation(path, "what next?")).toMatchObject({
      residual: [
        "what next?",
        "Done: the cache test passes.",
        "fix the cache test",
        "Redis it is.",
        "We use Redis for caching.",
      ],
      previousTyped: "fix the cache test",
    });
  });

  test("nothing before a compaction counts, and a missing transcript leaves the prompt", () => {
    const path = transcript([
      typed("The database is postgres."),
      { type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: postgres." } },
      typed("run the tests"),
    ]);
    expect(recentConversation(path, "and now?")).toMatchObject({
      residual: ["and now?", "run the tests"],
      previousTyped: "run the tests",
    });
    expect(recentConversation(join(tmpdir(), "no-such-transcript.jsonl"), "hi")).toEqual({
      toolResults: [],
      residual: ["hi"],
      previousTyped: "",
    });
  });

  test("the current prompt's own line, when already written (R0 F8), is not one of the 2 earlier prompts", () => {
    const path = transcript([typed("first ask"), typed("second ask"), typed("third ask"), typed("the current ask")]);
    expect(recentConversation(path, "the current ask")).toMatchObject({
      residual: ["the current ask", "third ask", "second ask"],
      previousTyped: "third ask",
    });
  });

  test("the same read gives the last 10 tool results, oldest first, and the newest assistant text with its time", () => {
    const at = "2026-09-01T09:00:05.000Z";
    const results = Array.from({ length: 12 }, (_, i) => toolResult(`result ${i}`));
    const path = transcript([said("older"), ...results, { ...said("Shall I merge it?"), timestamp: at }]);
    const recent = recentConversation(path, "yes");
    expect(recent.toolResults).toEqual(Array.from({ length: 10 }, (_, i) => `result ${i + 2}`));
    expect(recent.lastAssistant).toEqual({ text: "Shall I merge it?", t: Date.parse(at) });
  });

  test("an episode or rule is residual at content-token Jaccard ≥ 0.6 with one sentence", () => {
    const sentences = residualSentences([
      "which auth provider does apps/web use?",
      "We use Redis. The db is postgres.",
    ]);
    expect(isResidual("which auth provider does apps/web use?", sentences)).toBe(true);
    expect(isResidual("[episode · 0m] We use Redis", sentences)).toBe(true);
    expect(isResidual("We switched apps/web from Auth0 to Clerk", sentences)).toBe(false);
    expect(isResidual("", sentences)).toBe(false);
  });

  test("a bullet of several sentences is residual when each of its sentences is", () => {
    const prompt = "We use ZebraCache for caching. The Zebra billing service runs on port 4021. Reply with just OK.";
    const sentences = residualSentences([prompt, "Reply with just OK."]);
    expect(isResidual(prompt, sentences)).toBe(true);
    expect(isResidual("Reply with just OK. We use ZebraCache for caching.", sentences)).toBe(true);
    expect(isResidual("We use ZebraCache for caching. The deploy target is fly.io.", sentences)).toBe(false);
  });

  test("a fact is residual only when its value and its subject share a sentence", () => {
    const sentences = residualSentences(["which auth provider does apps/web use?", "So the database is postgres."]);
    const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
    expect(isResidualNote(fact("In apps/web the auth provider is Auth0"), sentences)).toBe(false);
    expect(isResidualNote(fact("The database is postgres"), sentences)).toBe(true);
    expect(isResidualNote(fact("The cache is postgres"), sentences)).toBe(false);
    expect(
      isResidualNote({ id: "e", text: "which auth provider does apps/web use?", kind: "episode" }, sentences),
    ).toBe(true);
  });

  test("a typed prompt is one Claude Code marks `origin.kind: human` (R6 §1.1); other origins are not typed", () => {
    const human = (text: string) => ({ ...typed(text), origin: { kind: "human" } });
    const notification = { ...typed("<task-notification>done</task-notification>"), origin: { kind: "task" } };
    const path = transcript([human("First prompt."), said("One."), notification, human("Second prompt.")]);
    const recent = recentConversation(path, "Third prompt.");
    expect(recent.residual).toEqual(["Third prompt.", "Second prompt.", "One.", "First prompt."]);
    expect(recent.previousTyped).toBe("Second prompt.");
  });

  test("a negated value never states its slot: 'not postgres', 'no longer use postgres' (D7)", () => {
    const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
    const sentences = residualSentences(["The database is not postgres anymore.", "We no longer use the postgres db."]);
    expect(isResidualNote(fact("The database is postgres"), sentences)).toBe(false);
  });

  test("a bare 'use V' states V's slot without naming its subject (D7: V in one slot's value class)", () => {
    const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
    const sentences = residualSentences(["Use pnpm, not npm, for every install."]);
    expect(isResidualNote(fact("The package manager is pnpm"), sentences)).toBe(true);
    expect(isResidualNote(fact("The package manager is npm"), sentences)).toBe(false);
  });

  test("a slot is a fact with a slot-shaped value (D7); a longer value is a misparse, read as an episode", () => {
    const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
    expect(legacySlot(fact("The database is postgres."))).toEqual({ subject: "database", value: "postgres" });
    expect(legacySlot(fact("The node version is node 20"))).toEqual({ subject: "node version", value: "node 20" });
    expect(legacySlot(fact("The build is broken, can you look at the login page"))).toBeUndefined();
    expect(legacySlot(fact("Auth is failing"))).toBeUndefined();
    expect(legacySlot({ id: "e", text: "The database is postgres", kind: "episode" })).toBeUndefined();
  });
});
