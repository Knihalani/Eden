/**
 * D12: which transcript entries the user typed (src=user), and the pasted spans removed from them. Lines are
 * shaped as Claude Code 2.1.2xx writes them (the harness's key list, R6 §1.1).
 */
import { describe, expect, test } from "bun:test";
import { stripPastes, toolResultText, userTyped } from "./memory-authority";

const typed = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content },
  origin: { kind: "human" },
  promptSource: "typed",
  isSidechain: false,
  ...extra,
});
const queued = (prompt: string, commandMode: string, kind: string) => ({
  type: "attachment",
  attachment: { type: "queued_command", prompt, commandMode, origin: { kind } },
});

describe("userTyped: the entries D12 gives the user's authority", () => {
  test("a typed prompt", () => expect(userTyped(typed("fix the login bug"))).toBe("fix the login bug"));
  test("a queued prompt line", () => {
    expect(userTyped(typed("and the tests", { promptSource: "queued" }))).toBe("and the tests");
  });
  test("a queued prompt attachment (mid-turn)", () => {
    expect(userTyped(queued("also check CI", "prompt", "human"))).toBe("also check CI");
  });
  test("text blocks are joined; images are skipped", () => {
    const content = [
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
      { type: "text", text: "what is wrong?" },
    ];
    expect(userTyped(typed(content))).toBe("look at this\nwhat is wrong?");
  });
  test("an older line without origin or promptSource", () => {
    expect(userTyped({ type: "user", message: { role: "user", content: "rename the flag" } })).toBe("rename the flag");
  });

  const notTyped: [string, unknown][] = [
    ["a task notification", typed("<task-notification>done</task-notification>", { origin: { kind: "task-notification" } })],
    ["a notification by origin alone", typed("Agent finished", { origin: { kind: "task-notification" } })],
    ["a peer message (meta)", typed("Another Claude session sent a message:\nhi", { isMeta: true, origin: { kind: "peer" } })],
    ["a system-sourced line", typed("tick", { promptSource: "system" })],
    ["a compaction summary", typed("This session is being continued…", { isCompactSummary: true })],
    ["a tool result", typed([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])],
    ["a subagent's task (sidechain)", typed("Explore the repo", { isSidechain: true })],
    ["an assistant line", { type: "assistant", message: { role: "assistant", content: "Done." } }],
    ["a slash command", typed("<command-name>/next</command-name>\n<command-message>next</command-message>")],
    ["a local command's output", typed("<local-command-stdout>ok</local-command-stdout>")],
    ["a local command caveat", typed("<local-command-caveat>Caveat: …</local-command-caveat>")],
    ["a system reminder", typed("<system-reminder>be brief</system-reminder>")],
    ["a bash-mode input", typed("<bash-input>ls</bash-input>")],
    ["an agent message", typed("<agent-message>status</agent-message>")],
    ["a cross-session message", typed("<cross-session-message>hello</cross-session-message>")],
    ["a teammate message", typed('<teammate-message from="a">hi</teammate-message>')],
    ["an interruption marker", typed([{ type: "text", text: "[Request interrupted by user for tool use]" }])],
    ["a queued task notification", queued("<task-notification>x</task-notification>", "task-notification", "task-notification")],
    ["an empty prompt", typed("   ")],
  ];
  for (const [name, line] of notTyped) test(`not: ${name}`, () => expect(userTyped(line)).toBeUndefined());
});

describe("toolResultText", () => {
  test("string and block contents", () => {
    expect(toolResultText(typed([{ type: "tool_result", tool_use_id: "a", content: "first" }]))).toBe("first");
    const blocks = [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "second" }] }];
    expect(toolResultText(typed(blocks))).toBe("second");
  });
  test("a prompt is not a tool result", () => expect(toolResultText(typed("hello"))).toBeUndefined());
});

describe("stripPastes: D12's pasted spans", () => {
  test("a marked paste, between matching ids", () => {
    const text = 'why does this fail?\n<pasted_content id="p1">\nError: boom\n</pasted_content id="p1">\nthanks';
    expect(stripPastes(text)).toBe("why does this fail?\nthanks");
  });
  test("an unclosed paste marker strips to the end", () => {
    expect(stripPastes('see below\n<pasted_content id="p2">\nlog line')).toBe("see below");
  });
  test("fenced code, closed or not", () => {
    expect(stripPastes("run this:\n```ts\nconst a = 1;\n```\nis it right?")).toBe("run this:\nis it right?");
    expect(stripPastes("try\n~~~\nmake all")).toBe("try");
  });
  test("> quotes", () => {
    expect(stripPastes("you said:\n> use yarn\n>  always\nbut we use pnpm.")).toBe("you said:\nbut we use pnpm.");
  });
  test("three or more lines without sentence-final punctuation; two stay", () => {
    const log = "at a (x.ts:1)\nat b (y.ts:2)\nat c (z.ts:3)";
    expect(stripPastes(`the stack is below.\n${log}\nwhy?`)).toBe("the stack is below.\nwhy?");
    expect(stripPastes(`see:\n${log}\nwhy?`)).toBe("why?");
    expect(stripPastes("todo\n- add tests\nthen ship it.")).toBe("todo\n- add tests\nthen ship it.");
  });
  test("a span of 200+ characters seen in a recent tool result; shorter ones stay", () => {
    const long = "x".repeat(120) + " middle " + "y".repeat(120) + ".";
    const recent = [`stdout: ${long} (exit 0)`];
    expect(stripPastes(`what does this mean?\n\n${long}`, recent)).toBe("what does this mean?");
    expect(stripPastes(`what does this mean?\n\n${long}`, [])).toBe(`what does this mean?\n\n${long}`);
    expect(stripPastes("is ok. fine.", ["is ok. fine."])).toBe("is ok. fine.");
  });
  test("blank lines left by a strip collapse, and the ends are trimmed", () => {
    expect(stripPastes("one.\n\n```\ncode\n```\n\n\ntwo.\n")).toBe("one.\n\ntwo.");
  });
});
