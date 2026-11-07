import { expect, test } from "bun:test";
import { earlierPackets, userTurnBreakpoint } from "./packet-layout";

const bp = { type: "ephemeral" };

test("kept: every earlier request's packets stay; ephemeral: none do (D336)", () => {
  const day = [["p0"], [], ["p2a", "p2b"]];
  expect(earlierPackets("kept", day)).toEqual(day);
  expect(earlierPackets("ephemeral", day)).toEqual([[], [], []]);
  expect(earlierPackets("ephemeralBp", day)).toEqual([[], [], []]);
});

test("a breakpoint goes on the request's user turn when a packet follows it, not on a tool result", () => {
  const body = {
    messages: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: "the request" },
      { role: "system", content: [{ type: "text", text: "packet", cache_control: bp }] },
    ],
  };
  userTurnBreakpoint(body);
  expect(body.messages[2]!.content).toEqual([{ type: "text", text: "the request", cache_control: bp }]);
  expect(body.messages[0]!.content).toBe("earlier");

  // A turn that called a tool: the request's text turn gets it, the tool result (already last) keeps pi-ai's own.
  const tool: { messages: { role: string; content: unknown }[] } = {
    messages: [
      { role: "user", content: [{ type: "text", text: "the request" }] },
      { role: "system", content: [{ type: "text", text: "packet" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", cache_control: bp }] },
    ],
  };
  userTurnBreakpoint(tool);
  expect(tool.messages[0]!.content).toEqual([{ type: "text", text: "the request", cache_control: bp }]);
  const marks = JSON.stringify(tool).split("cache_control").length - 1;
  expect(marks).toBe(2);
});

test("no second breakpoint when the user turn is already last, and never more than four in all", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "r", cache_control: bp }] }] };
  userTurnBreakpoint(body);
  expect(JSON.stringify(body).split("cache_control").length - 1).toBe(1);
  // Tools, system and last already marked: one more makes four, Anthropic's limit; a fifth is never added.
  const full = {
    tools: [{ name: "t", cache_control: bp }],
    system: [{ type: "text", text: "s", cache_control: bp }],
    messages: [
      { role: "user", content: "r" },
      { role: "system", content: [{ type: "text", text: "p", cache_control: bp }] },
    ],
  };
  userTurnBreakpoint(full);
  expect(JSON.stringify(full).split("cache_control").length - 1).toBe(4);
  const over = { ...full, messages: [...full.messages], extra: { cache_control: bp } };
  over.messages[0] = { role: "user", content: "r" };
  userTurnBreakpoint(over);
  expect(JSON.stringify(over.messages[0])).not.toContain("cache_control");
});
