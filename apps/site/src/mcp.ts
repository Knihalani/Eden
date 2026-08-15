import type { EdenDb } from "./db";
import { playTool } from "./playback";

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

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
    const tools = await db.all<{
      id: string;
      name: string;
      when_to_use: string;
      steps: string;
    }>(`SELECT id, name, when_to_use, steps FROM tool WHERE workspace_id = ? AND state = 'on'`, [workspaceId]);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => {
          const steps = JSON.parse(t.steps || "[]") as Array<{ url?: string }>;
          const params = new Set<string>();
          for (const s of steps) {
            for (const m of String(s.url || "").matchAll(/\{(\w+)\}/g)) {
              if (m[1] !== "origin") params.add(m[1]);
            }
          }
          const properties: Record<string, { type: string }> = {};
          for (const p of params) properties[p] = { type: "string" };
          if (!Object.keys(properties).length) properties.args = { type: "string" };
          return {
            name: t.name,
            description: (t.when_to_use || t.name).slice(0, 160),
            inputSchema: { type: "object", properties },
          };
        }),
      },
    };
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    const args = (params?.arguments || {}) as Record<string, string>;
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE workspace_id = ? AND name = ? AND state = 'on'`,
      [workspaceId, name],
    );
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${name}` } };
    }
    const receipt = await playTool(db, tool, { ...args, origin });
    const text =
      typeof receipt.facts === "string" ? receipt.facts : JSON.stringify(receipt.facts ?? receipt.result);
    const trailer = `Eden ${receipt.steps_ok}/${receipt.steps_attempted} · ${receipt.raw_bytes}→${receipt.densified_bytes}B · ${receipt.server_ms}ms`;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `${trailer}\n${text}` }],
      },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } };
}
