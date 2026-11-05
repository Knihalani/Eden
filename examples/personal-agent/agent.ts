#!/usr/bin/env bun
/**
 * A minimal personal-agent loop with Eden beside it. The agent is any OpenAI-compatible chat model; Eden sees each
 * event, adds context before each model call, and is offered to the model as an `ask_context` tool.
 *
 *   EDEN_DEV=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev    # terminal 1
 *   bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"     # terminal 2, offline
 *   OPENAI_API_KEY=… bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"   # a real model
 *
 * Without OPENAI_API_KEY (or with AGENT_MODEL=stub) the agent is a scripted stand-in that needs no key and no
 * network beyond Eden: it calls `ask_context` once with the user's request, then replies with what it was given, so
 * the whole loop (observe, injected context, ask) runs for free. OPENAI_BASE_URL / AGENT_MODEL point the agent at
 * any OpenAI-compatible endpoint (OpenRouter works); EDEN_URL at a server other than http://127.0.0.1:8790.
 */
import { ASK_CONTEXT_DESCRIPTION, EdenClient, withContext } from "@eden/client";

// No key against the dev server; EDEN_API_KEY against one with EDEN_API_KEYS set. Eden fails open, so a wrong key
// shows up only through onError.
const eden = new EdenClient({
  apiKey: process.env.EDEN_API_KEY,
  baseUrl: process.env.EDEN_URL || undefined,
  userId: "demo-user",
  sessionId: `demo-${Date.now()}`,
  onError: (e) => console.error(`[eden] ${e instanceof Error ? e.message : e}`),
});
const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.AGENT_MODEL ?? "gpt-4o-mini";
const offline = !process.env.OPENAI_API_KEY || model === "stub";
if (offline) console.error("[agent] no OPENAI_API_KEY: running the offline stub model (AGENT_MODEL=stub)");

type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; function: { name: string; arguments: string } };

const tools = [
  {
    type: "function",
    function: {
      name: "ask_context",
      // The description the server's MCP `ask_context` gives (without `askGuard`), so this agent is told the same.
      description: ASK_CONTEXT_DESCRIPTION,
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    },
  },
];

/** Context Eden injected unasked (the system messages `withContext` adds), as the stub model saw it, once each. */
const injected = new Set<string>();

/**
 * The offline stand-in for a model: on the user's turn it asks Eden about the request; once the tool answered, it
 * replies with what Eden gave it, asked and unasked. Deterministic, so the example doubles as a smoke test.
 */
function stub(messages: Message[]): Message {
  for (const m of messages) if (m.role === "system" && m.content?.startsWith("<context")) injected.add(m.content);
  const tool = messages.findLast((m) => m.role === "tool");
  if (!tool) {
    const question = messages.findLast((m) => m.role === "user")?.content ?? "";
    const call = { id: "call-0", function: { name: "ask_context", arguments: JSON.stringify({ question }) } };
    return { role: "assistant", content: null, tool_calls: [call] };
  }
  return { role: "assistant", content: [`(stub model) Eden says: ${tool.content}`, ...injected].join("\n\n") };
}

async function chat(messages: Message[]): Promise<Message> {
  if (offline) return stub(messages);
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
// The client waits up to 3,000 ms on a sent user message by default (DEFAULT_WAIT_MS, D112), the wait the default
// engine and its reader were measured with: see "How long to wait" in docs/INTEGRATION.md. EDEN_WAIT_MS overrides it
// (0 turns the wait off); unset, empty or not a number keeps the client's default.
const rawWaitMs = process.env.EDEN_WAIT_MS;
const parsedWaitMs = rawWaitMs === undefined || rawWaitMs.trim() === "" ? NaN : Number(rawWaitMs);
const waitMs = Number.isFinite(parsedWaitMs) ? Math.max(0, parsedWaitMs) : undefined;
const { injection } = await eden.observe({ kind: "user_message", text: userText }, { waitMs });

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
