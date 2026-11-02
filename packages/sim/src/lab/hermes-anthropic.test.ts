import { describe, expect, test } from "bun:test";
import { fromAnthropicJson, StreamTranslator, toAnthropicBody } from "./hermes-anthropic";

describe("toAnthropicBody", () => {
  const body = {
    model: "ignored",
    temperature: 0.7,
    max_tokens: 9_000,
    stream: true,
    tools: [
      { type: "function", function: { name: "a", description: "A", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ],
    messages: [
      { role: "system", content: "You are Hermes." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: "Eden: context" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: '{"q":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "" },
    ],
  };

  test("maps roles, tools and caches the stable prefix", () => {
    const out = toAnthropicBody(body, "claude-haiku-5-5", 2_000, true) as Record<string, any>;
    expect(out.model).toBe("claude-haiku-5-5");
    expect(out.max_tokens).toBe(2_000);
    expect(out.temperature).toBeUndefined();
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.stream).toBe(true);
    expect(out.system).toEqual([
      { type: "text", text: "You are Hermes.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Eden: context" },
    ]);
    expect(out.tools.map((t: any) => t.name)).toEqual(["a", "b"]);
    expect(out.tools[0].cache_control).toBeUndefined();
    expect(out.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(out.tool_choice).toEqual({ type: "auto" });
    expect(out.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out.messages[1].content).toEqual([{ type: "tool_use", id: "c1", name: "a", input: { q: 1 } }]);
    // Consecutive tool results are one user turn; the last block carries the conversation's breakpoint.
    expect(out.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "r1" },
      { type: "tool_result", tool_use_id: "c2", content: "(empty)", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("a conversation that does not start with a user turn gets one", () => {
    const out = toAnthropicBody({ messages: [{ role: "assistant", content: "x" }] }, "m", 10, false) as any;
    expect(out.messages[0].role).toBe("user");
    expect(out.stream).toBeUndefined();
  });
});

describe("responses", () => {
  test("a JSON reply becomes a chat completion with cached tokens in usage", () => {
    const { completion, usage } = fromAnthropicJson(
      {
        id: "m1",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "a", input: { x: 2 } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 },
      },
      "claude-haiku-5-5",
    ) as any;
    expect(usage).toEqual({ input: 10, cacheRead: 90, cacheWrite: 5, output: 7 });
    expect(completion.choices[0].finish_reason).toBe("tool_calls");
    expect(completion.choices[0].message.tool_calls[0].function).toEqual({ name: "a", arguments: '{"x":2}' });
    expect(completion.usage.prompt_tokens).toBe(105);
    expect(completion.usage.prompt_tokens_details.cached_tokens).toBe(90);
  });

  test("a stream becomes chunks: text, tool-call deltas, finish, usage, DONE", () => {
    const tr = new StreamTranslator("m");
    const out = [
      { type: "message_start", message: { id: "m1", usage: { input_tokens: 3, cache_read_input_tokens: 50 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "a" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q"' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]
      .map((e) => tr.push(e))
      .join("");
    const chunks = out
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "Hi" });
    expect(chunks[1].choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: "t1", function: { name: "a" } });
    expect(chunks[2].choices[0].delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: '{"q"' } });
    expect(chunks[3].choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[4].usage).toMatchObject({ prompt_tokens: 53, completion_tokens: 12 });
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(tr.firstContent).toBe(true);
  });
});
