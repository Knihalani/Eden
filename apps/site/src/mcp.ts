import type { EdenDb } from "./db";
import {
  bundleJson,
  compactReceipt,
  compactRowFromFacts,
  mcpInstructions,
  prRowsFromFacts,
  receiptJson,
  selectMcpTools,
  shortenWhenToUse,
  templateKeys,
} from "@eden/core";
import { playTool, warmWorkspaceBundle } from "./playback";

// Warming is fire-and-forget: it touches the database and the network long
// after the response has been sent. On Node an unhandled rejection here would
// take the whole process down (default since v15), so it is observed and
// dropped — warming is best-effort cache filling by design.
function warmInBackground(db: EdenDb, workspaceId: string, origin: string): void {
  void warmWorkspaceBundle(db, workspaceId, origin).catch(() => undefined);
}

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

function schemaFor(steps: Array<{ url?: string; bind?: Record<string, string> }>) {
  const keys = templateKeys(steps.map((s) => s.url || ""));
  const properties: Record<string, { type: string; description: string }> = {};
  if (keys.includes("issue") || keys.includes("run_id")) {
    properties.issues = {
      type: "string",
      description: "csv of ids. returns JSON array of compact rows",
    };
  }
  properties.ids = {
    type: "string",
    description: "csv of ids. returns JSON array of compact rows",
  };
  return { type: "object", properties, required: [] as string[] };
}

function listPublishedOnly(): boolean {
  return process.env.EDEN_LIST_MCP !== "1";
}

type ToolRow = {
  id: string;
  name: string;
  when_to_use: string;
  steps: string;
  uses_count: number | null;
};

/** The tools this workspace would serve, after the same selection tools/list applies. */
async function liveTools(db: EdenDb, workspaceId: string): Promise<ToolRow[]> {
  const rows = await db.all<ToolRow>(
    listPublishedOnly()
      ? `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on' AND published = 1`
      : `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on'`,
    [workspaceId],
  );
  return selectMcpTools(rows);
}

export async function handleMcp(db: EdenDb, workspaceId: string, body: Rpc, origin: string): Promise<unknown> {
  const { method, id, params } = body;
  if (method === "initialize") {
    warmInBackground(db, workspaceId, origin);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "eden", version: "0.1.0" },
        // The protocol's own route into the system prompt. Without a CLI hook
        // or an LLM proxy this is the only steering a hosted Eden has.
        instructions: mcpInstructions(await liveTools(db, workspaceId)),
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    const listed = await liveTools(db, workspaceId);
    warmInBackground(db, workspaceId, origin);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: listed.map((t) => {
          let steps: Array<{ url?: string; bind?: Record<string, string> }> = [];
          try {
            steps = JSON.parse(t.steps || "[]") as Array<{ url?: string; bind?: Record<string, string> }>;
          } catch {
            steps = [];
          }
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
    const alias = args.pr || args.number || args.id;
    if (!args.issue && alias) args.issue = alias;
    if (!args.ids && args.issues) args.ids = args.issues;
    if (!args.issues && args.ids) args.issues = args.ids;
    if (!args.issues && args.issue) args.issues = args.issue;
    if (!args.issue && args.issues) args.issue = String(args.issues).split(/[,\s]+/)[0] ?? "";
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE workspace_id = ? AND name = ? AND state = 'on'`,
      [workspaceId, name],
    );
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } };
    }
    let receipt;
    try {
      receipt = await playTool(db, tool, { ...args, origin });
    } catch (err) {
      // A corrupt tool row is a server-side data problem, but the caller is
      // still owed a JSON-RPC answer — not a connection-killing 500.
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `tool execution failed: ${(err as Error).message}` },
      };
    }
    const ids = String(args.issues || args.ids || args.issue || "")
      .split(/[,\s]+/)
      .filter(Boolean);
    const prRows = receipt.rows?.length
      ? receipt.rows
      : prRowsFromFacts(receipt.facts, ids);
    const generic =
      prRows.length
        ? null
        : ids.length
          ? ids
              .map((n, i) => {
                const facts =
                  receipt.facts && typeof receipt.facts === "object" && Array.isArray((receipt.facts as { rows?: unknown }).rows)
                    ? (receipt.facts as { rows: unknown[] }).rows[i]
                    : receipt.facts;
                return compactRowFromFacts(facts, n);
              })
              .filter((r): r is Record<string, unknown> => r !== null)
          : (() => {
              const row = compactRowFromFacts(receipt.facts, args.issue);
              return row ? [row] : [];
            })();
    const text = prRows.length
      ? bundleJson(prRows).trimEnd()
      : generic?.length
        ? receiptJson(generic).trimEnd()
        : receipt.table || compactReceipt(receipt.facts);
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
