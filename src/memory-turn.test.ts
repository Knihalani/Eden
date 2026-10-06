import { describe, expect, test } from "bun:test";
import { isNonHumanSubmit, isProposal, promptHash, turnMode } from "./memory-turn";

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
    expect(turnMode("which test environment does vitest.config use?")).toBe("imperative");
  });
});
