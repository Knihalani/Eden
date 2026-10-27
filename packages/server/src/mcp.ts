/**
 * The partner as an MCP server, so any MCP-capable agent can ask it questions with one tool, `ask_context`.
 * Proactive delivery cannot ride on MCP (a server cannot speak unasked into the agent's context); that needs the
 * events API or the SDK's message hook.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderAnswer, type ContextPartner } from "@eden/engine";
import type { Scope } from "@eden/protocol";
import { z } from "zod";

export function createMcpServer(partner: ContextPartner, who: Scope & { sessionId: string }): McpServer {
  const server = new McpServer({ name: "eden-context", version: "0.0.0" });
  server.registerTool(
    "ask_context",
    {
      description:
        "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, " +
        "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their " +
        "people, projects or history that is not in the conversation.",
      inputSchema: { question: z.string().min(1).max(2_000) },
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const res = await partner.ask({ ...who, question });
      // Titles and URLs are source text (an email subject is attacker-controlled): they go in a data envelope too.
      const cites = res.citations.map((c, i) => `[${i}] ${c.sourceId}: ${c.title}${c.url ? ` (${c.url})` : ""}`);
      const text = cites.length ? `${res.answer}\n\nSources:\n${renderAnswer(cites.join("\n"))}` : res.answer;
      return { content: [{ type: "text", text }] };
    },
  );
  return server;
}
