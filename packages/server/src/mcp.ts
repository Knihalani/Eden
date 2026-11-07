/**
 * The partner as an MCP server, so any MCP-capable agent can ask it questions with one tool, `ask_context`.
 * Proactive delivery cannot ride on MCP (a server cannot speak unasked into the agent's context); that needs the
 * events API or the SDK's message hook.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderAnswer, safeLine, type ContextPartner } from "@eden/engine";
import { ASK_CONTEXT_DESCRIPTION, type Scope } from "@eden/protocol";
import { z } from "zod";

/** An MCP session's id lasts until this long with no ask (the engine's `sessionIdleMs` default) or a UTC day ends. */
export const MCP_SESSION_IDLE_MS = 2 * 3_600_000;

export interface McpServerOptions {
  /** The clock for session rotation (tests). */
  now?: () => number;
  idleMs?: number;
}

export function createMcpServer(
  partner: ContextPartner,
  who: Scope & { sessionId: string },
  opts: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "eden-context", version: "0.0.0" });
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? MCP_SESSION_IDLE_MS;
  // D281: MCP sends no session end, and a stdio server lives as long as its client (days). With one id for its whole
  // life the reader's per-session cap (20 calls, $0.02) was spent once and the reader stayed off until a restart. The
  // id moves on after an idle gap or at UTC midnight, and the old session is ended so its state goes at once.
  let session = { id: who.sessionId, n: 0, day: Math.floor(now() / 86_400_000), last: now() };
  const sessionNow = async (): Promise<string> => {
    const t = now();
    const day = Math.floor(t / 86_400_000);
    if (day !== session.day || t - session.last >= idleMs) {
      const ended = session.id;
      const n = session.n + 1;
      session = { id: `${who.sessionId}.${n}`, n, day, last: t };
      await partner
        .observe({ tenantId: who.tenantId, userId: who.userId, sessionId: ended, at: t, kind: "session_end" })
        .catch(() => undefined);
    }
    session.last = t;
    return session.id;
  };
  server.registerTool(
    "ask_context",
    {
      description: ASK_CONTEXT_DESCRIPTION,
      inputSchema: { question: z.string().min(1).max(2_000) },
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const res = await partner.ask({ ...who, sessionId: await sessionNow(), question });
      // Titles and URLs are source text (an email subject is attacker-controlled): they go in a data envelope too, one
      // line each (`safeLine`, D221), so a line break in a title cannot forge another `[n]` source line.
      const cites = res.citations.map(
        (c, i) => `[${i}] ${safeLine(c.sourceId)}: ${safeLine(c.title)}${c.url ? ` (${safeLine(c.url)})` : ""}`,
      );
      const text = cites.length ? `${res.answer}\n\nSources:\n${renderAnswer(cites.join("\n"))}` : res.answer;
      return { content: [{ type: "text", text }] };
    },
  );
  return server;
}
