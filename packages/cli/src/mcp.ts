import { readConfig, resolveApiKey, wrapPlaneUrl } from "./home";
import type { StretchProgram } from "@eden/ir";
import { whenToUseOf } from "@eden/ir";
import { dispatchMessages, dispatchPrograms } from "@eden/wrap";

type Rpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: Record<string, unknown> };

const CACHE_MS = 5_000;

function edenTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(Number(process.env.EDEN_TIMEOUT_MS) || 60_000);
}

export class McpAuthError extends Error {
  readonly status = 401;
  constructor() {
    super("unauthorized");
  }
}

export async function handleMcp(msg: Rpc, ctx: {
  base: string;
  key: string;
  programs: () => Promise<StretchProgram[]>;
  send: (id: unknown, result: unknown) => void;
  error?: (id: unknown, code: number, message: string) => void;
}): Promise<void> {
  const fail = (id: unknown, code: number, message: string) => {
    if (ctx.error) ctx.error(id, code, message);
    else ctx.send(id, { error: { code, message } });
  };
  if (msg.method === "initialize") {
    ctx.send(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "eden", version: "0.1.0" },
      instructions:
        "Eden compiles repeated tool sequences into single calls. tools/list is an empty catalog. POST tools/dispatch with the conversation messages to receive at most one schema when the transcript matches a live program, or an empty list when nothing matches.",
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "ping") {
    ctx.send(msg.id, {});
    return;
  }
  if (msg.method === "resources/list") {
    try {
      await ctx.programs();
      ctx.send(msg.id, { resources: [] });
    } catch (err) {
      if (err instanceof McpAuthError || (err as { status?: number }).status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      fail(msg.id, -32603, String(err));
    }
    return;
  }
  if (msg.method === "resources/read") {
    const uri = String(msg.params?.uri ?? "");
    try {
      const live = await ctx.programs();
      const p = live.find((x) => `eden://program/${x.id}` === uri || `eden://program/${x.name}` === uri);
      if (!p) {
        fail(msg.id, -32002, "not found");
        return;
      }
      ctx.send(msg.id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(p) }] });
    } catch (err) {
      if (err instanceof McpAuthError || (err as { status?: number }).status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      fail(msg.id, -32603, String(err));
    }
    return;
  }
  if (msg.method === "prompts/list") {
    ctx.send(msg.id, { prompts: [] });
    return;
  }
  if (msg.method === "tools/list") {
    try {
      await ctx.programs();
      ctx.send(msg.id, { tools: [] });
    } catch (err) {
      if (err instanceof McpAuthError || (err as { status?: number }).status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      fail(msg.id, -32603, String(err));
    }
    return;
  }
  if (msg.method === "tools/dispatch") {
    let live: StretchProgram[];
    try {
      live = await ctx.programs();
    } catch (err) {
      if (err instanceof McpAuthError || (err as { status?: number }).status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      fail(msg.id, -32603, String(err));
      return;
    }
    try {
      const picked = dispatchPrograms(dispatchMessages(msg.params), live).slice(0, 1);
      ctx.send(msg.id, {
        tools: picked.map((p) => ({
          name: p.name,
          description: whenToUseOf(p),
          inputSchema: p.inputSchema,
          defer_loading: true,
          allowed_callers: ["direct", "code_execution_20260120"],
        })),
      });
    } catch {
      ctx.send(msg.id, { tools: [] });
    }
    return;
  }
  if (msg.method === "tools/call") {
    let live: StretchProgram[];
    try {
      live = await ctx.programs();
    } catch (err) {
      if (err instanceof McpAuthError || (err as { status?: number }).status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      ctx.send(msg.id, { content: [{ type: "text", text: String(err) }], isError: true });
      return;
    }
    const name = String(msg.params?.name ?? "");
    const p = live.find((x) => x.name === name);
    if (!p) {
      ctx.send(msg.id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      return;
    }
    try {
      const r = await fetch(`${ctx.base.replace(/\/$/, "")}/v1/wrap-run`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.key}`, "content-type": "application/json" },
        body: JSON.stringify({ program: p, input: msg.params?.arguments ?? {}, timeoutMs: Number(process.env.EDEN_TIMEOUT_MS) || 60_000 }),
        signal: edenTimeoutSignal(),
      });
      if (r.status === 401) {
        fail(msg.id, -32001, "unauthorized");
        return;
      }
      if (r.ok) {
        const j = (await r.json()) as { value?: unknown };
        ctx.send(msg.id, { content: [{ type: "text", text: JSON.stringify(j.value) }] });
        return;
      }
      const text = await r.text();
      let detail = `wrap-run failed ${r.status}`;
      try {
        const j = JSON.parse(text) as { reason?: string; error?: string };
        detail = j.reason || j.error || detail;
      } catch {
        if (text) detail = text.slice(0, 400);
      }
      ctx.send(msg.id, { content: [{ type: "text", text: detail }], isError: true });
    } catch (err) {
      ctx.send(msg.id, { content: [{ type: "text", text: String(err) }], isError: true });
    }
    return;
  }
  if (msg.id != null) fail(msg.id, -32601, `method not found: ${msg.method ?? ""}`);
}

export function mcpHelp(): string {
  return `eden mcp — stdio MCP in front of wrap

  eden mcp               Start stdio JSON-RPC (needs wrap up)
  eden mcp --help        This letter; does not start stdio

tools/list is an empty catalog. Dispatch at most one schema when a live
program matches. Wrap down is original. Does not Approve.
`;
}

export async function runMcp(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(mcpHelp());
    return;
  }
  const cfg = readConfig();
  const base = wrapPlaneUrl(cfg?.base_url || process.env.EDEN_BASE_URL);
  const key = resolveApiKey(args);

  let cached: { at: number; programs: StretchProgram[] } | null = null;
  const programs = async (): Promise<StretchProgram[]> => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.programs;
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/v1/tools`, { headers: { authorization: `Bearer ${key}` }, signal: edenTimeoutSignal() });
      if (r.status === 401) throw new McpAuthError();
      if (!r.ok) throw new Error(`tools ${r.status}`);
      const j = (await r.json()) as { tools?: Array<{ program: StretchProgram; state: string }> };
      const live = (j.tools ?? []).filter((t) => t.state === "live").map((t) => t.program);
      cached = { at: Date.now(), programs: live };
      return live;
    } catch (err) {
      if (err instanceof McpAuthError) throw err;
      if (cached) return cached.programs;
      throw err;
    }
  };

  const send = (id: unknown, result: unknown) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  };
  const error = (id: unknown, code: number, message: string) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  };

  const leftover: Buffer[] = [];
  let chain = Promise.resolve();
  process.stdin.on("data", (c) => {
    leftover.push(c as Buffer);
    chain = chain.then(async () => {
      const text = Buffer.concat(leftover).toString("utf8");
      leftover.length = 0;
      const lines = text.split("\n");
      if (!text.endsWith("\n")) leftover.push(Buffer.from(lines.pop() ?? ""));
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        try {
          await handleMcp(msg, { base, key, programs, send, error });
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          if (msg.id !== undefined && msg.id !== null) error(msg.id, -32603, message);
          else process.stderr.write(`eden mcp: ${message}\n`);
        }
      }
    }).catch((err: unknown) => {
      process.stderr.write(`eden mcp: ${(err as Error)?.message ?? String(err)}\n`);
    });
  });
}

if (import.meta.main) await runMcp();
