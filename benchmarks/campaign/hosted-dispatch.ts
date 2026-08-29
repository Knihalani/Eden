/**
 * Wave 7.2 hosted-dispatch load probe.
 *
 * P1c already proves W=100 wrapTools on a shared ArmingStore. This probe is
 * the hosted path: a thin dispatcher assigns `sessionId` from the incoming
 * "connection" (MCP Streamable HTTP analog), then wrapTools on that session
 * of the multi-tenant store. Exactly-once writes. Zero unpinned anomalies.
 */
import { createArmingStore, createState, sharedAcrossLine, wrapTools, type ArmingStore, type ToolDef } from "@eden/wrap";
import type { StretchProgram } from "@eden/ir";
import { fireOblivious, linearProgram } from "./struggle-harness";
import { fetchTools, readOnlyFetchProgram } from "./fleet-dedupe";

export const HOSTED_DISPATCH_W = 100;

/** One hosted MCP/proxy connection. Session is assigned from this, not guessed. */
export type HostedConnection = {
  connectionId: string;
  /** Optional MCP session header analog. */
  mcpSession?: string;
};

export function sessionFromConnection(conn: HostedConnection): string {
  const raw = typeof conn.mcpSession === "string" && conn.mcpSession.length > 0 ? conn.mcpSession : conn.connectionId;
  return `hosted:${raw}`;
}

/**
 * Thin hosted dispatcher: connection → sessionId → wrapTools on the shared store.
 * This is what P1c is not — P1c mints sessionId in the test; a host assigns it
 * from the connection that just landed.
 */
export function hostedWrap(
  tools: Record<string, ToolDef>,
  opts: {
    programs: StretchProgram[];
    store: ArmingStore;
    connection: HostedConnection;
    fleetId?: string;
    agentId?: string;
    region?: string;
  },
): Record<string, ToolDef> {
  const sessionId = sessionFromConnection(opts.connection);
  const state = createState({
    programs: opts.programs ?? [],
    arming: opts.store,
    sessionId,
    ...(opts.fleetId ? { fleetId: opts.fleetId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.region ? { region: opts.region } : {}),
  });
  return wrapTools(tools, state) as Record<string, ToolDef>;
}

export type DispatchProbeResult = {
  W: number;
  writes: Record<string, number>;
  duplicateWrites: number;
  missingWrites: number;
  armingAdmits: number;
  armingRejects: number;
  sessions: string[];
  anomalies: string[];
};

function mkTools(writes: Record<string, number>, audits: Record<string, number>): Record<string, ToolDef> {
  const mk = (name: string, mutate?: (id: string) => void): ToolDef => ({
    description: name,
    execute: async (args: Record<string, unknown>) => {
      mutate?.(String(args.id));
      return { name, id: args.id };
    },
  });
  return {
    lookup: mk("lookup"),
    fetch: mk("fetch"),
    judge: mk("judge"),
    write: mk("write", (id) => {
      writes[id] = (writes[id] ?? 0) + 1;
    }),
    audit: mk("audit", (id) => {
      audits[id] = (audits[id] ?? 0) + 1;
    }),
  };
}

/**
 * W concurrent hosted connections, unique session each, shared store.
 * Same stretch as P1c so the comparison is apples-to-apples — the extra
 * piece is the connection→session dispatcher.
 */
export async function probeHostedDispatch(opts?: { W?: number }): Promise<DispatchProbeResult> {
  const W = opts?.W ?? HOSTED_DISPATCH_W;
  const writes: Record<string, number> = {};
  const audits: Record<string, number> = {};
  const tools = mkTools(writes, audits);
  const prog = linearProgram("p_hosted_dispatch", ["lookup", "fetch", "judge", "write", "audit"], { text: true });
  const store = createArmingStore();
  const sessions: string[] = [];
  const anomalies: string[] = [];

  await Promise.all(
    Array.from({ length: W }, (_, i) => {
      const connection: HostedConnection = { connectionId: `conn-${i}` };
      sessions.push(sessionFromConnection(connection));
      const wrapped = hostedWrap(tools, { programs: [prog], store, connection });
      return fireOblivious(wrapped, [
        { tool: "lookup", args: { id: `H-${i}`, text: `complaint ${i}` } },
        { tool: "fetch", args: { id: `H-${i}` } },
        { tool: "judge", args: { id: `H-${i}` } },
        { tool: "write", args: { id: `H-${i}` } },
        { tool: "audit", args: { id: `H-${i}` } },
      ]);
    }),
  );

  let duplicateWrites = 0;
  let missingWrites = 0;
  for (let i = 0; i < W; i++) {
    const id = `H-${i}`;
    const w = writes[id] ?? 0;
    const a = audits[id] ?? 0;
    if (w !== 1) {
      if (w > 1) duplicateWrites += w - 1;
      if (w < 1) missingWrites += 1;
      anomalies.push(`write ${id} count=${w}`);
    }
    if (a !== 1) anomalies.push(`audit ${id} count=${a}`);
  }
  if (store.stats().rejects !== 0) anomalies.push(`arming rejects=${store.stats().rejects}`);
  if (new Set(sessions).size !== W) anomalies.push(`session collision: ${new Set(sessions).size} unique of ${W}`);

  return {
    W,
    writes,
    duplicateWrites,
    missingWrites,
    armingAdmits: store.stats().admits,
    armingRejects: store.stats().rejects,
    sessions,
    anomalies,
  };
}

export type McpInitProbeResult = {
  W: number;
  ok: number;
  thrown: number;
  anomalies: string[];
  echoed: { v2024: number; v2025: number; degraded: number };
};

type InitBody = { jsonrpc: string; id: number; method: string; params?: unknown };

/**
 * W in-process MCP initialize calls with mixed protocolVersion proposals.
 * Must not throw. Result.protocolVersion must be a version we speak.
 */
export async function probeMcpInitialize(
  handle: (body: InitBody) => Promise<unknown>,
  W = HOSTED_DISPATCH_W,
): Promise<McpInitProbeResult> {
  const anomalies: string[] = [];
  let ok = 0;
  let thrown = 0;
  const echoed = { v2024: 0, v2025: 0, degraded: 0 };
  const proposals: unknown[] = [];
  for (let i = 0; i < W; i++) {
    switch (i % 5) {
      case 0:
        proposals.push(undefined);
        break;
      case 1:
        proposals.push("2025-03-26");
        break;
      case 2:
        proposals.push("2024-11-05");
        break;
      case 3:
        proposals.push("1.0.0");
        break;
      default:
        proposals.push(i % 10 === 4 ? { not: "a string" } : 2025);
        break;
    }
  }

  await Promise.all(
    proposals.map(async (protocolVersion, i) => {
      const params = protocolVersion === undefined ? {} : { protocolVersion };
      try {
        const res = (await handle({
          jsonrpc: "2.0",
          id: i + 1,
          method: "initialize",
          params,
        })) as { result?: { protocolVersion?: string }; error?: { code?: number } };
        const v = res?.result?.protocolVersion;
        if (v !== "2024-11-05" && v !== "2025-03-26") {
          anomalies.push(`init ${i} protocolVersion=${String(v)} error=${JSON.stringify(res?.error)}`);
          return;
        }
        if (v === "2024-11-05") echoed.v2024 += 1;
        else if (protocolVersion === "2025-03-26") echoed.v2025 += 1;
        else echoed.degraded += 1;
        ok += 1;
      } catch (err) {
        thrown += 1;
        anomalies.push(`init ${i} threw: ${(err as Error).message}`);
      }
    }),
  );

  if (thrown > 0) anomalies.push(`thrown=${thrown}`);
  return { W, ok, thrown, anomalies, echoed };
}

/** Two hosted connections, one fleet, same read-only GET — duplicate fetches vanish. */
export async function probeHostedFleetGet(): Promise<{
  fetchIssue: number;
  fetchComments: number;
  sharedLine: string | undefined;
}> {
  const execs: Record<string, number> = {};
  const prog = readOnlyFetchProgram("p_hosted_fleet");
  const store = createArmingStore();
  const script = [
    { tool: "fetchIssue", args: { id: "E-1" } },
    { tool: "fetchComments", args: { id: "E-1" } },
  ];
  const aState = createState({
    programs: [prog],
    arming: store,
    sessionId: sessionFromConnection({ connectionId: "conn-intake" }),
    fleetId: "fleet-hosted",
    agentId: "intake",
  });
  const bState = createState({
    programs: [prog],
    arming: store,
    sessionId: sessionFromConnection({ connectionId: "conn-billing" }),
    fleetId: "fleet-hosted",
    agentId: "billing",
  });
  await Promise.all([
    fireOblivious(wrapTools(fetchTools(execs), aState) as Record<string, ToolDef>, script),
    fireOblivious(wrapTools(fetchTools(execs), bState) as Record<string, ToolDef>, script),
  ]);
  const line = sharedAcrossLine(2);
  const reasons = [...aState.receipts, ...bState.receipts].map((r) => r.reason ?? "");
  return {
    fetchIssue: execs["fetchIssue:E-1"] ?? 0,
    fetchComments: execs["fetchComments:E-1"] ?? 0,
    sharedLine: reasons.find((r) => r.includes(line)),
  };
}

if (import.meta.main) {
  const r = await probeHostedDispatch({ W: HOSTED_DISPATCH_W });
  console.log(
    JSON.stringify(
      {
        W: r.W,
        duplicateWrites: r.duplicateWrites,
        missingWrites: r.missingWrites,
        armingAdmits: r.armingAdmits,
        armingRejects: r.armingRejects,
        uniqueSessions: new Set(r.sessions).size,
        anomalies: r.anomalies,
      },
      null,
      2,
    ),
  );
  process.exit(r.anomalies.length === 0 && r.duplicateWrites === 0 ? 0 : 1);
}
