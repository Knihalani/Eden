#!/usr/bin/env bun
/**
 * A minimal personal-agent loop with Eden beside it. The agent is any OpenAI-compatible chat model; Eden sees each
 * event, adds context before each model call, and is offered to the model as an `ask_context` tool.
 *
 *   EDEN_DEV=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev    # terminal 1
 *   OPENAI_API_KEY=… bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"   # terminal 2
 *
 * OPENAI_BASE_URL / AGENT_MODEL point the agent at any OpenAI-compatible endpoint (OpenRouter works).
 */
import { EdenClient, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey: "dev", userId: "demo-user", sessionId: `demo-${Date.now()}` });
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.AGENT_MODEL ?? "gpt-4o-mini";

type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; function: { name: string; arguments: string } };

const tools = [
  {
    type: "function",
    function: {
      name: "ask_context",
      description: "Ask about the user's people, plans, messages or documents. Searches their connected accounts.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    },
  },
];

async function chat(messages: Message[]): Promise<Message> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, tools }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { choices: { message: Message }[] }).choices[0]!.message;
}

const userText = process.argv.slice(2).join(" ") || "What's on my plate this week?";
let messages: Message[] = [
  { role: "system", content: "You are the user's personal assistant. Be brief." },
  { role: "user", content: userText },
];

await eden.observe({ kind: "session_start", agent: "example" });
// waitMs: this agent can afford a short wait on the first turn for a fresher lookup.
const { injection } = await eden.observe({ kind: "user_message", text: userText }, { waitMs: 1_500 });

for (let step = 0; step < 5; step++) {
  const reply = await chat(withContext(messages, await eden.collect(step === 0 ? injection : null)));
  messages.push(reply);
  if (!reply.tool_calls?.length) {
    console.log(reply.content);
    await eden.observe({ kind: "agent_message", text: reply.content ?? "" });
    break;
  }
  for (const call of reply.tool_calls) {
    const { question } = JSON.parse(call.function.arguments) as { question: string };
    await eden.observe({ kind: "tool_call", tool: call.function.name, input: { question } });
    const answer = (await eden.ask(question))?.answer ?? "No context available.";
    messages.push({ role: "tool", tool_call_id: call.id, content: answer });
  }
}
await eden.observe({ kind: "session_end" });
