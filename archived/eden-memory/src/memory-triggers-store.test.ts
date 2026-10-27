/**
 * P2.2 in the store: `recall` delivers the policies and intents a typed prompt's classes fire (A4 §5.1 step 4b), and
 * never retrieves a keyed rule row by word overlap (D18: policies are delivered by triggers, not similarity).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "./index";
import { INTENT_TTL_MS } from "./memory-policy";

const NOW = Date.parse("2026-10-11T12:00:00Z");
let dir = "";
const prevNow = process.env.EDEN_NOW;
const prevConsent = process.env.EDEN_MEMORY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eden-triggers-"));
  process.env.EDEN_NOW = String(NOW);
  delete process.env.EDEN_MEMORY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = prevNow;
  if (prevConsent === undefined) delete process.env.EDEN_MEMORY;
  else process.env.EDEN_MEMORY = prevConsent;
});

function store(...statements: string[]): AgentMemory {
  const mem = openMemory({ dir });
  for (const text of statements) {
    mem.rememberTyped([{ text }]);
    process.env.EDEN_NOW = String(Number(process.env.EDEN_NOW) + 60_000);
  }
  return mem;
}

const recalled = (mem: AgentMemory, prompt: string) =>
  mem.recall([{ role: "user", content: prompt }]).map((note) => note.text);

describe("compiled triggers in recall", () => {
  test("a fired class delivers the rule keyed on it, with no word in common", () => {
    const mem = store("Never merge pull requests yourself.", "We use pnpm.");
    const notes = recalled(mem, "looks done, can you land it?");
    expect(notes.some((text) => text.includes("Never merge pull requests yourself"))).toBe(true);
    expect(notes.some((text) => text.includes("pnpm"))).toBe(false);
  });

  test("an intent is delivered while it lives, and not after its 7 days", () => {
    const mem = store("Don't open the PR yet.");
    expect(recalled(mem, "put this up for review").some((text) => text.includes("open the PR yet"))).toBe(true);
    process.env.EDEN_NOW = String(NOW + INTENT_TTL_MS + 3_600_000);
    const later = openMemory({ dir });
    expect(recalled(later, "put this up for review").some((text) => text.includes("open the PR yet"))).toBe(false);
  });

  test("a keyed rule row is not retrieved by word overlap (D18)", () => {
    const mem = store("Never deploy to production on Fridays.");
    // "Fridays" and "production" overlap, but the prompt asks for information: no class fires.
    expect(recalled(mem, "where do production logs go on Fridays?")).toEqual([]);
  });

  test("an unkeyed rule stays on the lexical path (D18: topical rules are not triggers)", () => {
    const mem = store("Run the full test suite, not only the changed tests, before pushing.");
    expect(recalled(mem, "which tests does the full suite run?").some((text) => text.includes("full test suite"))).toBe(
      true,
    );
  });

  test("a class word inside a pasted span fires nothing (A4 §3.0)", () => {
    const mem = store("Never merge pull requests yourself.");
    const pasted = '<pasted_content id="1">\nCI log: merged 3 commits\n</pasted_content id="1">\nfix the typo';
    expect(recalled(mem, pasted).some((text) => text.includes("merge pull requests"))).toBe(false);
  });

  test("a superseded rule is not delivered; the rule that overturned it is", () => {
    const mem = store("Always squash when merging.", "Never squash, keep every commit.");
    const notes = recalled(mem, "squash these into one");
    expect(notes.some((text) => text.includes("Always squash"))).toBe(false);
    expect(notes.some((text) => text.includes("Never squash"))).toBe(true);
  });

  test("delivers at most 2 rules of one class, the newest first", () => {
    const mem = store(
      "Never deploy on Fridays.",
      "Never deploy without a changelog.",
      "Never deploy to prod at night.",
    );
    const notes = recalled(mem, "deploy it").filter((text) => /\bdeploy\b/.test(text));
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain("at night");
    expect(notes[1]).toContain("changelog");
  });
});
