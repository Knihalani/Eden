import { afterAll, describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { handleApi } from "./api";
import { Store, toolFlagsJson } from "./store";
import {
  AUDIT_COLUMNS,
  GENESIS,
  exportAudit,
  hashPayload,
  verifyAudit,
} from "./audit-export";
import {
  REVIEW_COLUMNS,
  actorOf,
  chainReviewRecords,
  exportAccessReview,
  parseAccessReview,
  reviewRecordsFromStore,
  serializeAccessReview,
  verifyAccessReview,
} from "./access-review";

useTempEdenHome();

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  if (PREV_DEV === undefined) delete process.env.EDEN_DEV;
  else process.env.EDEN_DEV = PREV_DEV;
});

const TOKEN = "eden_dev";

const passManifest = {
  llmReduction: 5,
  latencyReduction: 2,
  costReduction: 2,
  skipRateBefore: 0.5,
  skipRateAfter: 0,
  nShadow: 6,
  tokensMeasured: true,
  timeMeasured: false,
  tokensSaved: 400,
  timeSavedMs: null,
};

function program(id: string, version = "v1"): StretchProgram {
  return {
    id,
    version,
    name: `tool ${id}`,
    description: "",
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
    manifest: null,
  };
}

function seedTool(
  store: Store,
  over: {
    id?: string;
    approved_by?: string;
    approved_at?: number;
    transparent_writes?: boolean;
    rollout?: "canary" | "live";
  } = {},
): void {
  const id = over.id ?? "tool_1";
  store.putTool({
    id,
    name: "lookup_issue",
    version: "v1",
    program: program(id, "v1"),
    state: "live",
    prev: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...(over.approved_by ? { approved_by: over.approved_by } : {}),
    ...(over.approved_at ? { approved_at: over.approved_at } : {}),
    ...(over.transparent_writes ? { transparent_writes: true } : {}),
    ...(over.rollout ? { rollout: over.rollout } : {}),
  });
}

function seedApprovable(store: Store, id = "tool_1"): void {
  store.putCandidate({
    id,
    sequence: ["a"],
    program: program(id),
    refusal: null,
    verdict: "PASS",
    manifest: passManifest,
    created_at: Date.now(),
  });
}

function headers(org?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...(org ? { "x-eden-org": org } : {}),
  };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("access-review chain", () => {
  test("who, what, when, and version are present", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a", approved_at: 1_700_000_111_000 });
    const records = reviewRecordsFromStore(store);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.who).toBe("org_a");
    expect(r.tool_id).toBe("tool_1");
    expect(r.name).toBe("lookup_issue");
    expect(r.version).toBe("v1");
    expect(r.at).toBe(1_700_000_111_000);
    expect(r.workspace_id).toBe(Store.WORKSPACE_ID);
    expect(r.prev).toBe(GENESIS);
    expect(r.seq).toBe(1);
    expect(r.sha256).toHaveLength(64);
  });

  test("pause does not rewrite Approve time", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a", approved_at: 1_700_000_111_000 });
    const t = store.tool("tool_1")!;
    t.state = "paused";
    t.updated_at = 1_700_000_999_000;
    store.putTool(t);
    const r = reviewRecordsFromStore(store)[0]!;
    expect(r.at).toBe(1_700_000_111_000);
    expect(r.at).not.toBe(t.updated_at);
    expect(store.tool("tool_1")!.approved_at).toBe(1_700_000_111_000);
  });

  test("unbound tool exports who=operator, never an invented person", () => {
    const store = new Store(":memory:");
    seedTool(store);
    const r = reviewRecordsFromStore(store)[0]!;
    expect(r.who).toBe("operator");
    expect(r.who).not.toMatch(/@/);
    expect(r.who).not.toMatch(/alice|kai|user/i);
  });

  test("empty store is 0 records and verify ok", () => {
    const jsonl = exportAccessReview(new Store(":memory:"), "jsonl");
    const csv = exportAccessReview(new Store(":memory:"), "csv");
    expect(verifyAccessReview(jsonl)).toEqual({ ok: true, n: 0 });
    expect(verifyAccessReview("")).toEqual({ ok: true, n: 0 });
    expect(verifyAccessReview(csv)).toEqual({ ok: true, n: 0 });
    expect(parseAccessReview(jsonl)).toEqual([]);
  });

  test("jsonl and csv round-trip", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a" });
    const original = reviewRecordsFromStore(store);
    const jsonl = serializeAccessReview(original, "jsonl");
    const csv = serializeAccessReview(original, "csv");
    expect(parseAccessReview(jsonl, "jsonl")).toEqual(original);
    expect(parseAccessReview(csv, "csv")).toEqual(original);
    expect(verifyAccessReview(jsonl).ok).toBe(true);
    expect(verifyAccessReview(csv).ok).toBe(true);
  });

  test("splicing a line fails verify", () => {
    const store = new Store(":memory:");
    seedTool(store, { id: "a", approved_by: "org_a" });
    seedTool(store, { id: "b", approved_by: "org_a" });
    seedTool(store, { id: "c", approved_by: "org_a" });
    const text = exportAccessReview(store, "jsonl");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const spliced = [...lines.slice(0, 1), ...lines.slice(2)].join("\n") + "\n";
    const result = verifyAccessReview(spliced);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("flipping a byte fails verify", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a" });
    const text = exportAccessReview(store, "jsonl");
    const i = text.indexOf("lookup_issue");
    expect(i).toBeGreaterThan(0);
    const flipped = text.slice(0, i) + "X" + text.slice(i + 1);
    expect(verifyAccessReview(flipped).ok).toBe(false);
  });

  test("wrong workspace query yields 0 records, not another tenant's rows", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a" });
    const empty = exportAccessReview(store, "jsonl", "ws_other");
    expect(verifyAccessReview(empty)).toEqual({ ok: true, n: 0 });
    expect(empty).not.toContain("lookup_issue");
    expect(empty).not.toContain("org_a");
    const local = exportAccessReview(store, "jsonl", Store.WORKSPACE_ID);
    expect(verifyAccessReview(local)).toEqual({ ok: true, n: 1 });
  });

  test("full audit export still verifies (sibling chain; AUDIT_COLUMNS unchanged)", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a" });
    expect(AUDIT_COLUMNS).toEqual([
      "seq",
      "kind",
      "id",
      "at",
      "tool_id",
      "name",
      "version",
      "state",
      "verdict",
      "reason",
      "ok",
      "prev",
      "sha256",
    ]);
    expect(REVIEW_COLUMNS).toContain("who");
    expect(REVIEW_COLUMNS).not.toEqual(AUDIT_COLUMNS as unknown as typeof REVIEW_COLUMNS);
    const audit = exportAudit(store, "jsonl");
    expect(verifyAudit(audit).ok).toBe(true);
    expect(hashPayload).toBeTypeOf("function");
  });

  test("actorOf never invents a person", () => {
    expect(actorOf(null)).toBe("operator");
    expect(actorOf("")).toBe("operator");
    expect(actorOf("  ")).toBe("operator");
    expect(actorOf("org_a")).toBe("org_a");
  });
});

describe("approved_by flags", () => {
  test("putTool round-trips approved_by without wiping transparent_writes or rollout", () => {
    const store = new Store(":memory:");
    seedTool(store, { approved_by: "org_a", transparent_writes: true, rollout: "canary" });
    const t = store.tool("tool_1")!;
    expect(t.approved_by).toBe("org_a");
    expect(t.transparent_writes).toBe(true);
    expect(t.rollout).toBe("canary");
    t.state = "paused";
    store.putTool(t);
    const paused = store.tool("tool_1")!;
    expect(paused.approved_by).toBe("org_a");
    expect(paused.transparent_writes).toBe(true);
    expect(paused.rollout).toBe("canary");
    const flags = JSON.parse(toolFlagsJson(paused)!);
    expect(flags).toEqual({ transparent_writes: true, rollout: "canary", approved_by: "org_a" });
  });
});

describe("GET /v1/audit/review", () => {
  test("wrong org is 403 and never another tenant's who/what", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedTool(store, { approved_by: "org_a" });
      const handler = createHandler({ store, token: TOKEN });
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const denied = await handler(
        new Request("http://x/v1/audit/review", { headers: headers("org_b") }),
      );
      expect(denied.status).toBe(403);
      const body = (await denied.json()) as { error: string };
      expect(body.error).toBe("workspace not bound to this org");
      expect(JSON.stringify(body)).not.toContain("lookup_issue");
    });
  });

  test("matching org returns who/what/when/version and a chain that verifies", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedTool(store, { approved_by: "org_a" });
      const handler = createHandler({ store, token: TOKEN });
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const res = await handler(
        new Request("http://x/v1/audit/review?format=jsonl", { headers: headers("org_a") }),
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(verifyAccessReview(text)).toEqual({ ok: true, n: 1 });
      const rec = parseAccessReview(text)[0]!;
      expect(rec.who).toBe("org_a");
      expect(rec.tool_id).toBe("tool_1");
      expect(rec.version).toBe("v1");
      expect(rec.at).toBeGreaterThan(0);
    });
  });

  test("?workspace= that is not ws_local is 0 records", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedTool(store, { approved_by: "org_a" });
      const handler = createHandler({ store, token: TOKEN });
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const res = await handler(
        new Request("http://x/v1/audit/review?workspace=ws_other", { headers: headers("org_a") }),
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(verifyAccessReview(text)).toEqual({ ok: true, n: 0 });
      expect(text).not.toContain("lookup_issue");
    });
  });

  test("unbound unmanaged still exports; who is operator", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedTool(store);
      const handler = createHandler({ store, token: TOKEN });
      const res = await handler(
        new Request("http://x/v1/audit/review", { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(res.status).toBe(200);
      const rec = parseAccessReview(await res.text())[0]!;
      expect(rec.who).toBe("operator");
    });
  });

  test("GET /v1/audit stays key-gated (not org-gated) and still verifies", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedTool(store, { approved_by: "org_a" });
      const handler = createHandler({ store, token: TOKEN });
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const noKey = await handler(new Request("http://x/v1/audit"));
      expect(noKey.status).toBe(401);
      const withKey = await handler(
        new Request("http://x/v1/audit", { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(withKey.status).toBe(200);
      expect(verifyAudit(await withKey.text()).ok).toBe(true);
    });
  });

  test("refuses without a key", async () => {
    const store = new Store(":memory:");
    const handler = createHandler({ store, token: TOKEN });
    const denied = await handler(new Request("http://x/v1/audit/review"));
    expect(denied.status).toBe(401);
  });

  test("a throw in review export is 500 JSON, never unhandled", async () => {
    const store = new Store(":memory:");
    store.tools = () => {
      throw new Error("boom");
    };
    const boom = await handleApi(
      new Request("http://x/v1/audit/review", { headers: { authorization: `Bearer ${TOKEN}` } }),
      new URL("http://x/v1/audit/review"),
      { store, token: TOKEN },
    );
    expect(boom?.status).toBe(500);
    expect(((await boom!.json()) as { error: string }).error).toBe("export failed");
  });
});

describe("Approve stamps approved_by", () => {
  test("x-eden-org is stamped; body.approved_by is ignored", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedApprovable(store);
      const handler = createHandler({ store, token: TOKEN });
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/approve", {
          method: "POST",
          headers: headers("org_a"),
          body: JSON.stringify({ approved_by: "alice@example.com" }),
        }),
      );
      expect(res.status).toBe(200);
      const t = store.tool("tool_1")!;
      expect(t.approved_by).toBe("org_a");
      expect(t.approved_by).not.toContain("@");
      const review = exportAccessReview(store, "jsonl");
      expect(parseAccessReview(review)[0]!.who).toBe("org_a");
    });
  });

  test("unbound unmanaged Approve stamps operator", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      seedApprovable(store);
      const handler = createHandler({ store, token: TOKEN });
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/approve", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(200);
      expect(store.tool("tool_1")?.approved_by).toBe("operator");
    });
  });
});

describe("csv injection on who", () => {
  test("formula-shaped who is neutralized and round-trips", () => {
    const records = chainReviewRecords([
      {
        who: "=cmd|' /C calc'!A0",
        tool_id: "t",
        name: "n",
        version: "v1",
        at: 1,
        workspace_id: Store.WORKSPACE_ID,
      },
    ]);
    const csv = serializeAccessReview(records, "csv");
    expect(csv).toContain("'=cmd");
    expect(csv.split("\n")[1]).not.toMatch(/^[=+\-@]/);
    expect(parseAccessReview(csv, "csv")[0]!.who).toBe("=cmd|' /C calc'!A0");
    expect(verifyAccessReview(csv).ok).toBe(true);
  });
});
