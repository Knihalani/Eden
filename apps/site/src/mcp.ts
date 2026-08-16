import type { EdenDb } from "./db";
import { bundleJson, compactReceipt, prRowsFromFacts, selectMcpTools, shortenWhenToUse } from "@eden/core";
import { playTool } from "./playback";

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

function schemaFor(_steps: Array<{ url?: string; bind?: Record<string, string> }>) {
  return {
    type: "object",
    properties: {
      issues: { type: "string", description: "csv of PR numbers. returns JSON [{number,title,reviews,status,files}]" },
    },
    required: [] as string[],
  };
}

function listPublishedOnly(): boolean {
  return process.env.EDEN_LIST_MCP !== "1";
}

export async function handleMcp(db: EdenDb, workspaceId: string, body: Rpc, origin: string): Promise<unknown> {
  const { method, id, params } = body;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "eden", version: "0.1.0" },
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    const published = listPublishedOnly();
    const tools = await db.all<{
      id: string;
      name: string;
      when_to_use: string;
      steps: string;
      uses_count: number | null;
    }>(
      published
        ? `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on' AND published = 1`
        : `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on'`,
      [workspaceId],
    );
    const listed = selectMcpTools(tools);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: listed.map((t) => {
          const steps = JSON.parse(t.steps || "[]") as Array<{ url?: string; bind?: Record<string, string> }>;
          return {
            name: t.name,
            description: shortenWhenToUse(t.when_to_use || t.name),
            inputSchema: schemaFor(steps),
          };
        }),
      },
    };
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = { ...((params?.arguments || {}) as Record<string, string>) };
    if (!args.issue && (args.pr || args.number)) args.issue = args.pr || args.number;
    if (!args.issues && args.issue) args.issues = args.issue;
    if (!args.issue && args.issues) args.issue = String(args.issues).split(/[,\s]+/)[0];
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE workspace_id = ? AND name = ? AND state = 'on'`,
      [workspaceId, name],
    );
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } };
    }
    const receipt = await playTool(db, tool, { ...args, origin });
    const rows = receipt.rows?.length ? receipt.rows : prRowsFromFacts(receipt.facts, String(args.issues || args.issue || "").split(/[,\s]+/).filter(Boolean));
    const text = rows.length ? bundleJson(rows).trimEnd() : receipt.table || compactReceipt(receipt.facts);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text }],
      },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
}
