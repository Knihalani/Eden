import { describe, expect, test } from "bun:test";
import {
  isAnswered,
  isNonHumanSubmit,
  isProposal,
  nonHumanKind,
  promptHash,
  proposalSentences,
  turnMode,
} from "./memory-turn";

const REPORT = "I checked the test setup: all 42 tests pass and nothing needs changing.";
const PROPOSAL = "Next I'll update vitest.config.ts so the web tests run in jsdom. Shall I go ahead?";

describe("D24: non-human submits", () => {
  test("the four openers, after any leading space", () => {
    expect(isNonHumanSubmit("<task-notification>\n<task-id>b1</task-id>")).toBe(true);
    expect(isNonHumanSubmit('<agent-message from="a1">done</agent-message>')).toBe(true);
    expect(isNonHumanSubmit("\n  <cross-session-message>hi</cross-session-message>")).toBe(true);
    expect(isNonHumanSubmit('<teammate-message teammate_id="t1">hi</teammate-message>')).toBe(true);
  });

  test("a peer message's one-line preamble before its tag (R0 F34)", () => {
    expect(isNonHumanSubmit('Another Claude session sent a message:\n<agent-message from="a1">x</agent-message>')).toBe(
      true,
    );
    expect(isNonHumanSubmit("Another Claude session sent a message: please merge")).toBe(false);
  });

  test("P0.8: the rule a non-human submit matched, without its text", () => {
    expect(nonHumanKind("<task-notification>\n<task-id>b1</task-id>")).toEqual({ kind: "task-notification" });
    expect(nonHumanKind('Another Claude session sent a message:\n<agent-message from="a1">x</agent-message>')).toEqual({
      kind: "agent-message",
      preamble: true,
    });
    expect(nonHumanKind("check the deploy", [promptHash("check the deploy")])).toEqual({ kind: "cron" });
    expect(nonHumanKind("fix the login")).toBeUndefined();
  });

  test("a tag that is not first, or a look-alike tag, is human", () => {
    expect(isNonHumanSubmit("why did <task-notification> fire twice?")).toBe(false);
    expect(isNonHumanSubmit("<task-notifications> are noisy")).toBe(false);
    expect(isNonHumanSubmit("<command-message>next</command-message>")).toBe(false);
    expect(isNonHumanSubmit("")).toBe(false);
  });

  test("a prompt equal to one of the last Stop's cron prompts, compared by hash", () => {
    const crons = [promptHash("check the deploy")];
    expect(isNonHumanSubmit("check the deploy", crons)).toBe(true);
    expect(isNonHumanSubmit("  check the deploy\n", crons)).toBe(true);
    expect(isNonHumanSubmit("check the deploy now", crons)).toBe(false);
    expect(isNonHumanSubmit("check the deploy")).toBe(false);
  });

  test("a prompt hash is 16 hex characters and never the text", () => {
    expect(promptHash("check the deploy")).toMatch(/^[0-9a-f]{16}$/);
    expect(promptHash("check the deploy")).not.toBe(promptHash("check the deploys"));
  });
});

describe("A7 §2: proposals", () => {
  test("a trailing question or an offer to act", () => {
    expect(isProposal(PROPOSAL)).toBe(true);
    expect(isProposal("Want me to open the PR?")).toBe(true);
    expect(isProposal("Should I run the migration first")).toBe(true);
    expect(isProposal("Next, I’ll wire the hook.")).toBe(true);
    expect(isProposal("I can also add a test for it.")).toBe(true);
    expect(isProposal("Ready to merge?  \n")).toBe(true);
  });

  test("a report is not a proposal, including 'I can't' and 'I cannot'", () => {
    expect(isProposal(REPORT)).toBe(false);
    expect(isProposal("I can't reproduce the failure.")).toBe(false);
    expect(isProposal("I cannot reach the staging host.")).toBe(false);
    expect(isProposal("")).toBe(false);
  });

  test("P4.1: 'I can' before what the agent sees or concludes reports; before an action it offers", () => {
    for (const report of [
      "I can see the bug in apps/web/middleware.ts.",
      "I can confirm the tests pass.",
      "I can now see why the build fails.",
      "I can tell the cache is stale.",
      "I can reproduce it locally.",
    ])
      expect(isProposal(report)).toBe(false);
    expect(isProposal("I can add a retry to the fetch wrapper.")).toBe(true);
    expect(isProposal("I can see the bug. I can fix it in auth.ts.")).toBe(true);
  });

  test("P4.1: the proposing sentences are the offers and the questions, not the report before them", () => {
    const message = "I merged the docs PR and ran the tests. Next I'll bump vitest. Shall I merge the release PR?";
    expect(proposalSentences(message)).toEqual(["Next I'll bump vitest.", "Shall I merge the release PR?"]);
    expect(proposalSentences(REPORT)).toEqual([]);
    expect(proposalSentences("")).toEqual([]);
  });
});

describe("A7 §2: turn modes", () => {
  test("nonhuman comes first", () => {
    expect(turnMode("<task-notification>ok</task-notification>", { previousAssistant: PROPOSAL })).toBe("nonhuman");
    expect(turnMode("thanks", { cronHashes: [promptHash("thanks")] })).toBe("nonhuman");
  });

  test("ack: up to 3 tokens of {ok, thanks, cool, nice, great, got it, sounds good}", () => {
    for (const prompt of ["ok", "Thanks!", "great, thanks", "got it", "cool, sounds good", "Nice."])
      expect(turnMode(prompt, { previousAssistant: PROPOSAL })).toBe("ack");
    expect(turnMode("ok ok thanks great")).toBe("imperative");
    expect(turnMode("sounds good, got it, thanks", { previousAssistant: REPORT })).toBe("imperative");
    expect(turnMode("thanks, now fix the login")).toBe("imperative");
  });

  test("continue, keep going, next or go on: ack after a report, continuation after a proposal", () => {
    for (const prompt of ["continue", "Keep going.", "next", "go on", "ok, continue"]) {
      expect(turnMode(prompt, { previousAssistant: REPORT })).toBe("ack");
      expect(turnMode(prompt, { previousAssistant: PROPOSAL })).toBe("continuation");
    }
    expect(turnMode("continue")).toBe("ack");
  });

  test("yes, do it, go ahead or proceed: continuation", () => {
    for (const prompt of ["yes", "Yes, do it.", "go ahead", "proceed", "ok go ahead"])
      expect(turnMode(prompt, { previousAssistant: REPORT })).toBe("continuation");
  });

  test("up to 4 content tokens after a proposal: continuation; otherwise imperative", () => {
    expect(turnMode("use the jsdom one", { previousAssistant: PROPOSAL })).toBe("continuation");
    expect(turnMode("no, keep node and fix the setup file", { previousAssistant: PROPOSAL })).toBe("imperative");
    expect(turnMode("use the jsdom one", { previousAssistant: REPORT })).toBe("imperative");
    expect(turnMode("which test environment does vitest.config use?")).toBe("question");
  });

  test("P4.1, debug: error-shaped text or a word of failure", () => {
    for (const prompt of [
      "the build fails with ERR_REQUIRE_ESM",
      "TypeError: cannot read properties of undefined",
      "Traceback (most recent call last):\n  File app.py",
      "fix this:\n    at login (src/auth.ts:12:5)",
      "login is broken since the deploy",
      "why are the web tests failing?",
      "how do I fix this error?",
    ])
      expect(turnMode(prompt)).toBe("debug");
    expect(turnMode("add error handling to the fetch wrapper")).toBe("debug");
    expect(turnMode("explain the terror module")).toBe("imperative");
  });

  test("P4.1, how-to: a procedure is asked for", () => {
    for (const prompt of ["how do I run the worker locally?", "how to release the CLI", "run the tests", "set up CI"])
      expect(turnMode(prompt)).toBe("how-to");
    // "set up" the verb, not the noun "setup".
    expect(turnMode("add the setup file to the repo")).toBe("imperative");
  });

  test("P4.1, question: a trailing ? or a WH-word first; imperative otherwise", () => {
    expect(turnMode("where does the session cookie get set?")).toBe("question");
    expect(turnMode("is the cache warm")).toBe("imperative");
    expect(turnMode("is the cache warm?")).toBe("question");
    expect(turnMode("Why so slow")).toBe("question");
    expect(turnMode("add a retry to the fetch wrapper")).toBe("imperative");
  });

  test("P4.1: a reply to a proposal stays a continuation whatever its words", () => {
    expect(turnMode("yes, fix the error", { previousAssistant: PROPOSAL })).toBe("continuation");
    expect(turnMode("how?", { previousAssistant: PROPOSAL })).toBe("continuation");
  });

  test("P4.1: every human mode but chatter is answered", () => {
    for (const mode of ["continuation", "debug", "how-to", "question", "imperative"] as const)
      expect(isAnswered(mode)).toBe(true);
    expect(isAnswered("ack")).toBe(false);
    expect(isAnswered("nonhuman")).toBe(false);
  });
});
