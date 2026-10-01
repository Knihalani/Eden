import type { EdenDb } from "./db";
import {
  bundleJson,
  compactReceipt,
  compactRowFromFacts,
  mcpInstructions,
  prRowsFromFacts,
  receiptJson,
  shortenWhenToUse,
  templateKeys,
} from "@eden/core";
import { negotiateMcpProtocolVersion, readMcpProtocolVersion } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import { compiledSchema, dispatchMessages, dispatchPrograms } from "@eden/wrap";
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
  // Domain-general: every template key the compiled steps actually use
  // becomes an argument, plus a CSV plural for batch fan-out. Nothing here
  // knows about GitHub — {issue}/{id} happen to be common keys, but so are
  // {order}, {customer}, {run_id}, {invoice}, and they all resolve the same
  // way at playback (resolveTemplate reads params by name).
  const keys = templateKeys(steps.map((s) => s.url || ""));
  const properties: Record<string, { type: string; description: string }> = {};
  for (const k of keys) {
    properties[k] = { type: "string", description: `${k} of the resource(s) to fetch` };
    properties[`${k}s`] = {
      type: "string",
      description: `csv of ${k}s — one compact row per id, fetched concurrently`,
    };
  }
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

type SiteStep = { url?: string; command?: string; bind?: Record<string, string> };

function parseSiteSteps(raw: string): SiteStep[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as SiteStep[]) : [];
  } catch {
    return [];
  }
}

function mcpToolSchema(t: ToolRow) {
  return {
    name: t.name,
    description: shortenWhenToUse(t.when_to_use || t.name),
    inputSchema: schemaFor(parseSiteSteps(t.steps)),
    defer_loading: true as const,
  };
}

/**
 * Hosted tool rows are not StretchPrograms. Rank skips `!p.manifest`, so stub
 * `manifest: {}`. First-step URL/command land in IR tool-step args so a GitHub
 * URL (or shell template) in the transcript can match the wrap JIT scorer.
 */
export function toolRowToProgram(row: ToolRow): StretchProgram {
  const siteSteps = parseSiteSteps(row.steps);
  const urls = siteSteps.map((s) => s.url).filter((u): u is string => typeof u === "string" && u.length > 0);
  const url = urls[0];
  const command = siteSteps.map((s) => s.command).find((c) => typeof c === "string" && c);
  const args: Record<string, { kind: "literal"; value: string } | { kind: "transform"; fn: "template"; expr: string }> =
    {};
  if (url) args.u = { kind: "literal", value: url };
  // Seeded forge URLs are `{origin}/forge/repos/…`. JIT scores concrete hosts,
  // so map that prefix to api.github.com — the same shape the MCP fixtures use —
  // without adding a playback step that would fetch GitHub.
  for (let i = 0; i < urls.length; i++) {
    const gh = urls[i]!.replace("{origin}/forge", "https://api.github.com");
    if (gh !== urls[i]) {
      args[`gh${i}`] = { kind: "literal", value: gh };
      const web = gh.replace("https://api.github.com/repos/", "https://github.com/");
      args[`web${i}`] = { kind: "literal", value: web };
      if (web.includes("/pulls/")) args[`html${i}`] = { kind: "literal", value: web.replace("/pulls/", "/pull/") };
    }
  }
  if (command) args.command = { kind: "transform", fn: "template", expr: command };
  return {
    id: row.id,
    version: "v1",
    name: row.name,
    description: row.when_to_use || row.name,
    inputSchema: schemaFor(siteSteps),
    steps: url || command ? [{ id: "s0", kind: "tool", tool: row.name, args }] : [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 0, minLlmReduction: 0, allowExact: false },
    manifest: {} as StretchProgram["manifest"],
    sequence: [row.name],
  } as StretchProgram;
}

/**
 * Every live row for this workspace. The old 6-tool list cap starved dispatch:
 * tool 7 never matched even when the transcript named it. Listing is empty now,
 * so ranking sees the whole library and still returns ≤1 schema.
 */
export async function liveTools(db: EdenDb, workspaceId: string): Promise<ToolRow[]> {
  return db.all<ToolRow>(
    listPublishedOnly()
      ? `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on' AND published = 1`
      : `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on'`,
    [workspaceId],
  );
}

/** Same On set wrap play uses. Dispatch must not hide a tool wrap can play. */
export async function liveOnTools(db: EdenDb, workspaceId: string): Promise<ToolRow[]> {
  return db.all<ToolRow>(
    `SELECT id, name, when_to_use, steps, uses_count FROM tool WHERE workspace_id = ? AND state = 'on'`,
    [workspaceId],
  );
}

function pickDispatchRow(rows: ToolRow[], params?: Record<string, unknown>): ToolRow | undefined {
  const messages = dispatchMessages(params);
  const picked = dispatchPrograms(messages, rows.map(toolRowToProgram));
  return picked[0] ? rows.find((r) => r.name === picked[0]!.name || r.id === picked[0]!.id) : undefined;
}

export function dispatchResult(
  rows: ToolRow[],
  params?: Record<string, unknown>,
): { tools: ReturnType<typeof mcpToolSchema>[] } {
  try {
    const hit = pickDispatchRow(rows, params);
    return { tools: hit ? [mcpToolSchema(hit)] : [] };
  } catch {
    return { tools: [] };
  }
}

/** Same OpenAI function schema local wrap POST /v1/dispatch returns. MCP keeps inputSchema. */
export function wrapDispatchResult(
  rows: ToolRow[],
  params?: Record<string, unknown>,
): { tools: ReturnType<typeof compiledSchema>[] } {
  try {
    const hit = pickDispatchRow(rows, params);
    return { tools: hit ? [compiledSchema(toolRowToProgram(hit))] : [] };
  } catch {
    return { tools: [] };
  }
}

export async function handleMcp(db: EdenDb, workspaceId: string, body: Rpc, origin: string): Promise<unknown> {
  const { method, id, params } = body;
  if (method === "initialize") {
    // Lifecycle: echo a supported client proposal; otherwise state our latest.
    // Hostile / missing / garbage protocolVersion must still be a JSON-RPC
    // result — never a thrown 500.
    const negotiated = negotiateMcpProtocolVersion(readMcpProtocolVersion(params));
    let instructions = "";
    try {
      warmInBackground(db, workspaceId, origin);
      instructions = mcpInstructions(await liveTools(db, workspaceId));
    } catch {
      instructions = mcpInstructions([]);
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiated.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "eden", version: "0.1.0" },
        // The protocol's own route into the system prompt. Without a CLI hook
        // or an LLM proxy this is the only steering a hosted Eden has.
        instructions,
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    // Empty catalog: listing live tools is a dump even at the old cap of 6.
    // Auth lives on the HTTP session (workspace id), not here.
    warmInBackground(db, workspaceId, origin);
    return { jsonrpc: "2.0", id, result: { tools: [] } };
  }
  if (method === "tools/dispatch") {
    let tools: ReturnType<typeof mcpToolSchema>[] = [];
    try {
      tools = dispatchResult(await liveOnTools(db, workspaceId), params).tools;
    } catch {
      tools = [];
    }
    warmInBackground(db, workspaceId, origin);
    return { jsonrpc: "2.0", id, result: { tools } };
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
    // Domain-general batching: any `<key>s` csv whose singular is one of this
    // tool's template keys routes into the same concurrent batch machinery
    // that issues/ids use. A compiled {order} tool therefore accepts
    // orders="11,12,13" without the server knowing what an order is.
    if (!args.ids && !args.issues) {
      const steps = (() => {
        try {
          const parsed = JSON.parse(tool.steps || "[]") as Array<{ url?: string }>;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [] as Array<{ url?: string }>;
        }
      })();
      for (const k of templateKeys(steps.map((s) => s.url || ""))) {
        const csv = args[`${k}s`];
        if (typeof csv === "string" && csv.trim()) {
          args.ids = csv;
          args.issues = csv;
          break;
        }
      }
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
    const prRows = receipt.rows?.length ? receipt.rows : prRowsFromFacts(receipt.facts, ids);
    const generic = prRows.length
      ? null
      : ids.length
        ? ids
            .map((n, i) => {
              const facts =
                receipt.facts &&
                typeof receipt.facts === "object" &&
                Array.isArray((receipt.facts as { rows?: unknown }).rows)
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
