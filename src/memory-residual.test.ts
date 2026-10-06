import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isResidual, isResidualNote, legacySlot, residualSentences, residualTexts } from "./memory-residual";

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
    expect(residualTexts(path, "what next?")).toEqual([
      "what next?",
      "Done: the cache test passes.",
      "fix the cache test",
      "Redis it is.",
      "We use Redis for caching.",
    ]);
  });

  test("nothing before a compaction counts, and a missing transcript leaves the prompt", () => {
    const path = transcript([
      typed("The database is postgres."),
      { type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: postgres." } },
      typed("run the tests"),
    ]);
    expect(residualTexts(path, "and now?")).toEqual(["and now?", "run the tests"]);
    expect(residualTexts(join(tmpdir(), "no-such-transcript.jsonl"), "hi")).toEqual(["hi"]);
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

  test("a slot is a fact with a slot-shaped value (D7); a longer value is a misparse, read as an episode", () => {
    const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
    expect(legacySlot(fact("The database is postgres."))).toEqual({ subject: "database", value: "postgres" });
    expect(legacySlot(fact("The node version is node 20"))).toEqual({ subject: "node version", value: "node 20" });
    expect(legacySlot(fact("The build is broken, can you look at the login page"))).toBeUndefined();
    expect(legacySlot(fact("Auth is failing"))).toBeUndefined();
    expect(legacySlot({ id: "e", text: "The database is postgres", kind: "episode" })).toBeUndefined();
  });
});
