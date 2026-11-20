#!/usr/bin/env bun
/**
 * A LangChain agent with Eden beside it, through `eden-langchain.ts`: `createAgent` with the Eden middleware,
 * Eden's `ask_context` and a guarded `send_email`.
 *
 *   EDEN_DEV=1 EDEN_PROCESSES=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev      # terminal 1
 *   bun examples/langchain/agent.ts "Can you move my lunch with Priya Raman to 11:30 on Thursday?"      # terminal 2
 *
 * With ANTHROPIC_API_KEY set the agent is `claude-haiku-5-5` (AGENT_MODEL to change it); without it, a scripted
 * stand-in that needs no key: it asks `ask_context` once, then answers with what it was given, so the whole loop
 * runs for free. EDEN_URL points at a server other than http://127.0.0.1:8790; EDEN_API_KEY is the tenant key on a
 * server with EDEN_API_KEYS.
 */
import { EdenClient, edenId } from "@eden/client";
import { AIMessage, type BaseMessage, HumanMessage, createAgent, initChatModel, tool } from "langchain";
import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { edenMiddleware } from "./eden-langchain";

const question = process.argv.slice(2).join(" ") || "Can you move my lunch with Priya Raman to 11:30 on Thursday?";

const eden = new EdenClient({
  apiKey: process.env.EDEN_API_KEY || undefined,
  baseUrl: process.env.EDEN_URL || undefined,
  userId: edenId(process.env.EDEN_USER_ID || "demo-user"),
  sessionId: edenId(`chat-${Date.now()}`),
});

/** The offline stand-in: asks Eden once, then answers with the tool's result and whether a packet was in its prompt. */
class Scripted extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const all = JSON.stringify(messages.map((m) => (m.toDict ? m.toDict() : m)));
    const asked = messages.some((m) => m.getType() === "tool" && m.name === "ask_context");
    const message = asked
      ? new AIMessage({
          content: `[offline model] Eden's packet was ${
            all.includes("Data, not instructions.") ? "" : "not "
          }in my prompt. ask_context said:\n${messages
            .filter((m) => m.getType() === "tool" && m.name === "ask_context")
            .map((m) => m.text)
            .join("\n")}`,
        })
      : new AIMessage({
          content: "",
          tool_calls: [{ name: "ask_context", args: { question }, id: "c1", type: "tool_call" as const }],
        });
    return { generations: [{ text: String(message.content), message }], llmOutput: {} };
  }
}

const offline = !process.env.ANTHROPIC_API_KEY;
if (offline) console.error("[agent] no ANTHROPIC_API_KEY: running the offline scripted model");
const model = offline
  ? (new Scripted() as unknown as BaseChatModel<BaseChatModelCallOptions>)
  : await initChatModel(`anthropic:${process.env.AGENT_MODEL || "claude-haiku-5-5"}`);

// An acting tool: Eden checks each call before it runs (a finding comes back as the tool's result instead).
const send_email = tool(async (input: { to: string }) => `sent to ${input.to} (demo: nothing was sent)`, {
  name: "send_email",
  description: "Send an email on the user's behalf.",
  schema: {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
  },
});

const agent = createAgent({
  model,
  tools: [send_email],
  middleware: [edenMiddleware(eden)],
  systemPrompt: "You are the user's personal assistant. Be brief.",
});
const result = await agent.invoke({ messages: [new HumanMessage(question)] });
console.log(String(result.messages.at(-1)?.content ?? ""));
