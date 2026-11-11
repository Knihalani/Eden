#!/usr/bin/env bun
/**
 * A Vercel AI SDK agent with Eden beside it, through `eden-ai-sdk.ts` (D854): `generateText` with the wrapped model,
 * Eden's `ask_context` and a guarded `send_email`.
 *
 *   EDEN_DEV=1 EDEN_PROCESSES=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev      # terminal 1
 *   bun examples/ai-sdk/agent.ts "Can you move my lunch with Priya Raman to 11:30 on Thursday?"          # terminal 2
 *
 * With ANTHROPIC_API_KEY set the agent is `claude-haiku-5-5` (AGENT_MODEL to change it); without it, a scripted
 * stand-in that needs no key: it asks `ask_context` once, then answers with what it was given, so the whole loop runs
 * for free. EDEN_URL points at a server other than http://127.0.0.1:8790; EDEN_API_KEY is the tenant key on a server
 * with EDEN_API_KEYS.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { EdenClient, edenId } from "@eden/client";
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { edenSession } from "./eden-ai-sdk";

const question = process.argv.slice(2).join(" ") || "Can you move my lunch with Priya Raman to 11:30 on Thursday?";

const eden = new EdenClient({
  apiKey: process.env.EDEN_API_KEY || undefined,
  baseUrl: process.env.EDEN_URL || undefined,
  userId: edenId(process.env.EDEN_USER_ID || "demo-user"),
  sessionId: edenId(`chat-${Date.now()}`),
});
const session = edenSession(eden);

/** The offline stand-in: asks Eden once, then answers with the tool's result and whether a packet was in its prompt. */
function scripted(): LanguageModel {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      step++;
      const usage = {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      };
      if (step === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "c1", toolName: "ask_context", input: JSON.stringify({ question }) },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      const all = JSON.stringify(prompt);
      const packet = all.includes("Data, not instructions.");
      const result = prompt
        .filter((m) => m.role === "tool")
        .flatMap((m) => m.content)
        .map((p) => (p.type === "tool-result" && p.output.type === "text" ? p.output.value : ""))
        .join("\n");
      const text = `[offline model] Eden's packet was ${packet ? "" : "not "}in my prompt. ask_context said:\n${result}`;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const offline = !process.env.ANTHROPIC_API_KEY;
if (offline) console.error("[agent] no ANTHROPIC_API_KEY: running the offline scripted model");
const model = offline ? scripted() : anthropic(process.env.AGENT_MODEL || "claude-haiku-5-5");

// An acting tool: Eden checks each call before it runs (a finding comes back as the tool's result instead).
const send_email = tool({
  description: "Send an email on the user's behalf.",
  inputSchema: jsonSchema<{ to: string; subject: string; body: string }>({
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
    required: ["to", "subject", "body"],
  }),
  execute: async ({ to }) => `sent to ${to} (demo: nothing was sent)`,
});

await session.started;
const result = await generateText({
  model: session.wrap(model),
  system: "You are the user's personal assistant. Be brief.",
  tools: { ...session.tools, ...session.guard({ send_email }) },
  stopWhen: stepCountIs(5),
  messages: [{ role: "user", content: question }],
});
console.log(result.text);
