import { describe, expect, test } from "bun:test";
import { isChatter, planSession, promptOf, submitClass } from "./r6-replay";

const text = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { content },
  ...extra,
});
const assistant = (...blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });

describe("which transcript lines are submits (R6 §1.2)", () => {
  test("typed, queued and skill prompts are human", () => {
    expect(submitClass(text("fix the login", { origin: { kind: "human" }, promptSource: "typed" }))).toBe("human");
    expect(submitClass(text("also the logout", { origin: { kind: "human" }, promptSource: "queued" }))).toBe("human");
    expect(submitClass(text([{ type: "text", text: "a prompt from an older version" }]))).toBe("human");
    const skill = "<command-message>next</command-message>\n<command-name>/next</command-name>";
    expect(submitClass(text(skill, { origin: { kind: "human" } }))).toBe("human");
  });

  test("task notifications and peer messages are non-human, meta or not", () => {
    const notification = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>";
    expect(submitClass(text(notification, { origin: { kind: "task-notification" } }))).toBe("task-notification");
    const peer = 'Another Claude session sent a message:\n<agent-message from="a1">done</agent-message>';
    expect(submitClass(text(peer, { origin: { kind: "peer" }, isMeta: true }))).toBe("peer");
  });

  test("tool results, meta lines, local commands, interrupts and compaction summaries are not submits", () => {
    expect(submitClass(text([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]))).toBeUndefined();
    expect(submitClass(text("Base directory for this skill: …", { isMeta: true }))).toBeUndefined();
    expect(submitClass(text("<command-name>/clear</command-name>\n<command-args></command-args>"))).toBeUndefined();
    expect(submitClass(text("<local-command-stdout>cleared</local-command-stdout>"))).toBeUndefined();
    expect(submitClass(text("[Request interrupted by user]"))).toBeUndefined();
    expect(submitClass(text("This session is being continued …", { isCompactSummary: true }))).toBeUndefined();
    expect(submitClass(text("a subagent's task", { isSidechain: true }))).toBeUndefined();
    expect(submitClass(text("   "))).toBeUndefined();
    expect(submitClass({ type: "assistant", message: { content: "hi" } })).toBeUndefined();
  });
});

test("a skill invocation is submitted as /name args, and any other prompt as its text", () => {
  expect(promptOf("<command-message>next</command-message>\n<command-name>/next</command-name>")).toBe("/next");
  const withArgs =
    "<command-message>slice</command-message>\n<command-name>/slice</command-name>\n<command-args>P0.2</command-args>";
  expect(promptOf(withArgs)).toBe("/slice P0.2");
  expect(promptOf("fix the <b> tag")).toBe("fix the <b> tag");
});

test("the plan: a start, then a Stop with the last assistant text before each submit that follows assistant work", () => {
  const lines = [
    text("first", { origin: { kind: "human" }, promptId: "p1" }),
    assistant({ type: "thinking", thinking: "…" }, { type: "text", text: "Working on it." }),
    assistant({ type: "tool_use", id: "t1", name: "Read", input: {} }),
    text([{ type: "tool_result", tool_use_id: "t1", content: "…" }]),
    assistant({ type: "text", text: "Done: the login works." }),
    text("<task-notification>…</task-notification>", { origin: { kind: "task-notification" } }),
    text("thanks", { origin: { kind: "human" }, promptId: "p2" }),
  ];
  expect(planSession(lines)).toEqual([
    { kind: "start", upTo: 0 },
    { kind: "submit", upTo: 0, submit: "human", prompt: "first", promptId: "p1" },
    { kind: "stop", upTo: 5, lastAssistantMessage: "Done: the login works." },
    {
      kind: "submit",
      upTo: 5,
      submit: "task-notification",
      prompt: "<task-notification>…</task-notification>",
      promptId: undefined,
    },
    { kind: "submit", upTo: 6, submit: "human", prompt: "thanks", promptId: "p2" },
  ]);
});

test("chatter is a prompt made only of A7 §2's ack or continuation words", () => {
  expect(isChatter("Continue.")).toBe(true);
  expect(isChatter("go ahead!")).toBe(true);
  expect(isChatter("thank you")).toBe(true);
  expect(isChatter("continue with the migration")).toBe(false);
  expect(isChatter("")).toBe(false);
});
