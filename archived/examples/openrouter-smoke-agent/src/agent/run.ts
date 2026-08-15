/**
 * Tool-calling agent loop instrumented with the published @eden-ai/sdk.
 * Traces land on prod Eden (default base URL) when org credentials are set.
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  begin,
  configure,
  getDefaultClient,
  identify,
  trace,
  wrapOpenAI,
} from "@eden-ai/sdk";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const AGENT_ID = "openrouter-smoke-agent";
const MAX_TOOL_ROUNDS = 8;

export interface AgentConfig {
  openRouterApiKey: string;
  model: string;
  edenOrgId: string;
  edenApiKey: string;
  edenBaseUrl?: string;
  edenProjectId?: string;
  userId?: string;
}

export interface AgentTurnEvent {
  type: "llm" | "tool" | "final" | "error" | "session";
  at: string;
  detail: Record<string, unknown>;
}

export interface AgentRunResult {
  reply: string;
  sessionId: string | null;
  model: string;
  toolCalls: number;
  llmRounds: number;
  events: AgentTurnEvent[];
  durationMs: number;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export async function runAgent(
  message: string,
  config: AgentConfig,
): Promise<AgentRunResult> {
  const started = Date.now();
  const events: AgentTurnEvent[] = [];
  const push = (
    type: AgentTurnEvent["type"],
    detail: Record<string, unknown>,
  ): void => {
    events.push({ type, at: new Date().toISOString(), detail });
  };

  const openRouterApiKey = requireNonEmpty(
    config.openRouterApiKey,
    "OpenRouter API key",
  );
  const model = requireNonEmpty(config.model, "Model id");
  const edenOrgId = requireNonEmpty(config.edenOrgId, "Eden org id");
  const edenApiKey = requireNonEmpty(config.edenApiKey, "Eden API key");
  const userId = (config.userId?.trim() || "smoke-tester").slice(0, 128);

  configure({
    orgId: edenOrgId,
    apiKey: edenApiKey,
    baseUrl: config.edenBaseUrl?.trim() || "https://api.edenobservability.com",
    projectId: config.edenProjectId?.trim() || "openrouter-smoke-agent",
    tags: ["smoke", "openrouter", "local-dashboard"],
    debug: true,
  });

  const raw = new OpenAI({
    apiKey: openRouterApiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://edenobservability.com",
      "X-Title": "Eden OpenRouter Smoke Agent",
    },
  });
  const client = wrapOpenAI(raw, { tags: ["smoke", "openrouter"] });

  const session = await begin({ agentId: AGENT_ID, userId });
  await identify(userId);
  push("session", {
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    userId,
  });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You are Eden Smoke Agent — a careful tool-using assistant.",
        "Use tools when they help answer accurately (time, math, city lookup).",
        "Prefer short, precise answers. After tools return, summarize clearly.",
        "If a tool fails, say so and continue with what you know.",
      ].join(" "),
    },
    { role: "user", content: message },
  ];

  let toolCalls = 0;
  let llmRounds = 0;
  let finalReply = "";

  try {
    const reply = await session.trace("agent-turn", async () => {
      return await trace("openrouter-smoke-agent", async () => {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          llmRounds += 1;
          const completion = await client.chat.completions.create({
            model,
            messages,
            tools: TOOL_DEFINITIONS,
            tool_choice: "auto",
            temperature: 0.2,
          });

          const choice = completion.choices[0];
          const assistantMessage = choice?.message;
          if (!assistantMessage) {
            throw new Error("OpenRouter returned an empty assistant message");
          }

          messages.push(assistantMessage);

          const calls = assistantMessage.tool_calls ?? [];
          push("llm", {
            round: llmRounds,
            model,
            finish_reason: choice.finish_reason,
            content_preview: (assistantMessage.content ?? "").slice(0, 240),
            tool_call_count: calls.length,
            usage: completion.usage ?? null,
          });

          if (!calls.length) {
            return (assistantMessage.content ?? "").trim() || "(empty reply)";
          }

          for (const call of calls) {
            if (call.type !== "function") continue;
            toolCalls += 1;
            const name = call.function.name;
            const args = call.function.arguments ?? "{}";

            const toolResult = await executeTool(name, args);
            push("tool", {
              round: llmRounds,
              tool: name,
              args: safeParse(args),
              result: toolResult,
            });

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(toolResult),
            });
          }
        }

        throw new Error(`Exceeded max tool rounds (${MAX_TOOL_ROUNDS})`);
      });
    });
    finalReply = typeof reply === "string" ? reply : String(reply);

    await session.completeSession(true);
    push("final", { reply: finalReply, ok: true });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    push("error", { message: messageText });
    await session.completeSession(false).catch(() => undefined);
    throw err;
  } finally {
    await getDefaultClient().flush();
  }

  return {
    reply: finalReply,
    sessionId: session.sessionId,
    model,
    toolCalls,
    llmRounds,
    events,
    durationMs: Date.now() - started,
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
