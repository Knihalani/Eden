#!/usr/bin/env bun
/**
 * A minimal personal-agent loop with Eden beside it. The agent is any OpenAI-compatible chat model; Eden sees each
 * event, adds context before each model call, is offered to the model as an `ask_context` tool, and checks each call
 * of the agent's acting tool before it runs (`guardTools`, D420: a finding comes back as the tool's result).
 *
 *   EDEN_DEV=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev    # terminal 1
 *   bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"     # terminal 2, offline (default)
 *   OPENAI_API_KEY=… bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"   # a real model
 *   OPENAI_BASE_URL=http://localhost:11434/v1 AGENT_MODEL=qwen3:8b \
 *     bun examples/personal-agent/agent.ts "move lunch with Priya Raman to Friday"        # a local model (Ollama)
 *
 * With AGENT_MODEL=stub — or no model endpoint at all — the agent is a scripted stand-in that needs no key and no
 * network beyond Eden: it calls `ask_context` once with the user's request, then replies with what it was given, so
 * the whole loop (observe, injected context, ask) runs for free. OPENAI_BASE_URL / AGENT_MODEL point the agent at
 * any OpenAI-compatible endpoint (OpenRouter works; a local Ollama, LM Studio or vLLM needs no key — the
 * Authorization header is sent only when OPENAI_API_KEY is set); EDEN_URL at a server other than
 * http://127.0.0.1:8790. Eden's own background roles run on the same kind of endpoint with
 * EDEN_MODEL_BASE_URL + EDEN_MODEL on the server side (D2109).
 */
import { ASK_CONTEXT_DESCRIPTION, EdenClient, guardTools, withContext, type Injection } from "@eden/client";

// No key against the dev server; EDEN_API_KEY against one with EDEN_API_KEYS set. Eden fails open, so a wrong key
// shows up only through onError.
const eden = new EdenClient({
  apiKey: process.env.EDEN_API_KEY,
  baseUrl: process.env.EDEN_URL || undefined,
  userId: "demo-user",
  sessionId: `demo-${Date.now()}`,
  onError: (e) => console.error(`[eden] ${e instanceof Error ? e.message : e}`),
});
const baseUrl = process.env.OPENAI_BASE_URL;
const model = process.env.AGENT_MODEL ?? "gpt-4o-mini";
// The stub runs when nothing real can be called: no key for the default OpenAI endpoint, and no
// OPENAI_BASE_URL pointing at one that needs none (a local Ollama/LM Studio takes a request keyless).
const offline = model === "stub" || (!process.env.OPENAI_API_KEY && !baseUrl);
if (offline)
  console.error("[agent] no model endpoint (OPENAI_API_KEY or OPENAI_BASE_URL): running the offline stub model");

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
  {
    type: "function",
    function: {
      name: "move_event",
      description: "Move one of the user's calendar events, and tell its guests.",
      parameters: {
        type: "object",
        properties: {
          event: { type: "string" },
          to: { type: "string" },
          notify: { type: "array", items: { type: "string" } },
        },
        required: ["event", "to"],
      },
    },
  },
];

// The agent's acting tools, each checked by Eden before it runs (D376, D420): on a finding (a guest only a stranger's
// mail named, say) the agent gets the finding as the tool's result instead, and calling again goes ahead. A demo
// stand-in: a real agent would call its calendar here.
const actions = guardTools(eden, {
  move_event: async (args: { event: string; to: string; notify?: string[] }) =>
    `(demo) moved ${args.event} to ${args.to}${args.notify?.length ? `, told ${args.notify.join(", ")}` : ""}`,
});

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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.OPENAI_API_KEY) headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  const res = await fetch(`${baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, tools }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { choices: { message: Message }[] }).choices[0]!.message;
}

// The default is the documented request above, which the sample sources answer: their calendar items carry no dates,
// so a date-scoped request ("what's on my plate this week?") honestly finds nothing and would greet a first run with
// "Nothing in the connected sources." (agent.test.ts runs the agent with no argument and expects a [calendar] item).
const userText = process.argv.slice(2).join(" ") || "move lunch with Priya Raman to Friday";
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

// Every packet an observe hands out is marked shown by Eden, so each one is placed before the next model call.
const carried: Injection[] = injection ? [injection] : [];
for (let step = 0; step < 5; step++) {
  // The returned list is kept as the transcript, so a packet stays in place on later calls (D336).
  messages = withContext(messages, [...carried.splice(0), ...(await eden.pending())]);
  const reply = await chat(messages);
  messages.push(reply);
  if (!reply.tool_calls?.length) {
    console.log(reply.content);
    await eden.observe({ kind: "agent_message", text: reply.content ?? "" });
    break;
  }
  for (const call of reply.tool_calls) {
    const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const called = await eden.observe({ kind: "tool_call", tool: call.function.name, input });
    if (called.injection) carried.push(called.injection);
    let content: string;
    if (call.function.name === "move_event") content = await actions.move_event(input as { event: string; to: string });
    else content = (await eden.ask(String(input.question ?? "")))?.answer ?? "No context available.";
    messages.push({ role: "tool", tool_call_id: call.id, content });
    const read = await eden.observe({ kind: "tool_result", tool: call.function.name, output: content });
    if (read.injection) carried.push(read.injection);
  }
}
await eden.observe({ kind: "session_end" });
