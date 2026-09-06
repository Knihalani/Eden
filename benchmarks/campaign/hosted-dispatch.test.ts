/**
 * Wave 7.2: hosted dispatch W≥100 on the multi-tenant store + MCP initialize
 * skew pins. Not P1c — session comes from the connection dispatcher.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmingStore } from "@eden/wrap";
import { openDb, type EdenDb } from "../../apps/site/src/db";
import { handleMcp } from "../../apps/site/src/mcp";
import { wrapPlay } from "../../apps/site/src/wrap";
import { fireOblivious, linearProgram } from "./struggle-harness";
import {
  HOSTED_DISPATCH_W,
  hostedWrap,
  probeHostedDispatch,
  probeHostedFleetGet,
  probeMcpInitialize,
  sessionFromConnection,
} from "./hosted-dispatch";

process.env.CAMPAIGN_THINK_MS = "1";
const TIMEOUT = 120_000;

describe("hosted dispatch load-probe", () => {
  test("session is assigned from the connection, not guessed", () => {
    expect(sessionFromConnection({ connectionId: "c1" })).toBe("hosted:c1");
    expect(sessionFromConnection({ connectionId: "c1", mcpSession: "mcp-sid" })).toBe("hosted:mcp-sid");
    expect(sessionFromConnection({ connectionId: "a" })).not.toBe(sessionFromConnection({ connectionId: "b" }));
  });

  test(
    `W=${HOSTED_DISPATCH_W} hosted connections × 1 stretch — all armed, zero duplicate writes`,
    async () => {
      const r = await probeHostedDispatch({ W: HOSTED_DISPATCH_W });
      // Pin: any anomaly here is a shipped bug, not a retry.
      expect(r.anomalies).toEqual([]);
      expect(r.duplicateWrites).toBe(0);
      expect(r.missingWrites).toBe(0);
      expect(r.armingRejects).toBe(0);
      expect(r.armingAdmits).toBeGreaterThanOrEqual(HOSTED_DISPATCH_W);
      expect(new Set(r.sessions).size).toBe(HOSTED_DISPATCH_W);
    },
    TIMEOUT,
  );

  test("two connections, same entity id — each writes once (no cross-session claim)", async () => {
    const writes: Record<string, number> = {};
    const prog = linearProgram("p_host_x", ["lookup", "write", "audit"], { text: true });
    const store = createArmingStore();
    const toolsFor = (tag: string) => ({
      lookup: {
        description: "lookup",
        execute: async (args: Record<string, unknown>) => ({ name: "lookup", id: args.id, tag }),
      },
      write: {
        description: "write",
        execute: async (args: Record<string, unknown>) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { name: "write", id: args.id, tag };
        },
      },
      audit: {
        description: "audit",
        execute: async (args: Record<string, unknown>) => ({ name: "audit", id: args.id, tag }),
      },
    });
    const a = hostedWrap(toolsFor("a"), { programs: [prog], store, connection: { connectionId: "conn-a" } });
    const b = hostedWrap(toolsFor("b"), { programs: [prog], store, connection: { connectionId: "conn-b" } });
    await Promise.all([
      fireOblivious(a, [
        { tool: "lookup", args: { id: "E-1", text: "a" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
      fireOblivious(b, [
        { tool: "lookup", args: { id: "E-1", text: "b" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
    ]);
    expect(writes.a).toBe(1);
    expect(writes.b).toBe(1);
  });

  test("two hosted connections, one fleet, same GET — second is claimed", async () => {
    const r = await probeHostedFleetGet();
    expect(r.fetchIssue).toBe(1);
    expect(r.fetchComments).toBe(1);
    expect(r.sharedLine).toContain("shared across 2 agents");
  });
});

describe("hosted MCP initialize W=100 (in-process handleMcp)", () => {
  let dir: string;
  let db: EdenDb;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["DATABASE_URL", "VERCEL", "EDEN_LIST_MCP"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "eden-hosted-mcp-"));
    db = await openDb(join(dir, "mcp.db"));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "W=100 initialize mixed protocolVersion — none throw, none 500, all a spoken version",
    async () => {
      const r = await probeMcpInitialize(
        (body) => handleMcp(db, "ws_local", body, "http://x"),
        HOSTED_DISPATCH_W,
      );
      expect(r.thrown).toBe(0);
      expect(r.ok).toBe(HOSTED_DISPATCH_W);
      expect(r.anomalies).toEqual([]);
      expect(r.echoed.v2024).toBeGreaterThan(0);
      expect(r.echoed.v2025).toBeGreaterThan(0);
      expect(r.echoed.degraded).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "W=100 wrapPlay on unique connection runIds — none throw",
    async () => {
      const id = crypto.randomUUID();
      await db.run(
        `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
         VALUES (?, 'ws_local', 'local_only', 'x', 'on', ?, '[]', 'fp')`,
        [id, JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }])],
      );
      const tool = {
        id,
        name: "local_only",
        steps: JSON.stringify([{ id: "s1", kind: "runner", name: "git.status" }]),
        seen: "[]",
      };
      const anomalies: string[] = [];
      const results = await Promise.all(
        Array.from({ length: HOSTED_DISPATCH_W }, async (_, i) => {
          try {
            return await wrapPlay(db, "ws_local", tool, {}, "http://127.0.0.1", `hosted-run-${i}`);
          } catch (err) {
            anomalies.push(`wrapPlay ${i} threw: ${(err as Error).message}`);
            return null;
          }
        }),
      );
      expect(anomalies).toEqual([]);
      expect(results.every((r) => r !== null)).toBe(true);
      expect(results.length).toBe(HOSTED_DISPATCH_W);
    },
    TIMEOUT,
  );
});
