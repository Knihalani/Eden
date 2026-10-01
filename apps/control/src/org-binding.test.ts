import { describe, expect, test } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import type { StretchProgram } from "@eden/ir";

/**
 * Org→workspace binding: the bearer token says nothing about tenancy (every
 * org of a deployment shares one key), so state-changing routes require the
 * caller's Clerk org id as x-eden-org and refuse anything the workspace is not
 * bound to. Read-only routes stay key-gated.
 */

useTempEdenHome();

const TOKEN = "test_key";

function auth(org?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...(org ? { "x-eden-org": org } : {}),
  };
}

function program(id: string): StretchProgram {
  return {
    id,
    version: "v1",
    name: `tool ${id}`,
    description: "",
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
    manifest: null,
  };
}

function seedTool(store: Store): void {
  store.putTool({
    id: "tool_1",
    name: "tool_1",
    version: "v1",
    program: program("tool_1"),
    state: "live",
    prev: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  });
}

function seedApprovableCandidate(store: Store): void {
  // The approve route addresses the candidate by its stretch id.
  store.putCandidate({
    id: "tool_1",
    sequence: ["a"],
    program: program("tool_1"),
    refusal: null,
    verdict: "PASS",
    // Passes canApprove: measured token savings, skipRateAfter 0.
    manifest: {
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
    },
    created_at: Date.now(),
  });
}

/** Managed/dev env is process-global; every test pins it and restores after. */
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

describe("org binding", () => {
  test("approve with a matching org succeeds", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedApprovableCandidate(store);
      const bind = await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      expect(bind.status).toBe(200);
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/approve", { method: "POST", headers: auth("org_a"), body: "{}" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(store.tool("tool_1")?.state).toBe("live");
    });
  });

  test("a mismatched org is refused with 403", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedApprovableCandidate(store);
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/approve", { method: "POST", headers: auth("org_b"), body: "{}" }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("workspace not bound to this org");
      // Nothing shipped: the candidate is still there.
      expect(store.candidatesCount()).toBe(1);
    });
  });

  test("pause/resume and dismiss carry the same gate", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedTool(store);
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      const pause = await handler(
        new Request("http://x/v1/tools/tool_1/pause", { method: "POST", headers: auth("org_b"), body: "{}" }),
      );
      expect(pause.status).toBe(403);
      expect(store.tool("tool_1")?.state).toBe("live");
      const okPause = await handler(
        new Request("http://x/v1/tools/tool_1/pause", { method: "POST", headers: auth("org_a"), body: "{}" }),
      );
      expect(okPause.status).toBe(200);
      // A bound workspace refuses even an absent org header.
      const noOrg = await handler(new Request("http://x/v1/candidates/cand_1", { method: "DELETE", headers: auth() }));
      expect(noOrg.status).toBe(403);
    });
  });

  test("an unmapped org on a managed install is refused", async () => {
    await withEnv({ DATABASE_URL: "postgres://managed", VERCEL: undefined, EDEN_DEV: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedTool(store);
      // No bindings at all: managed must refuse rather than fall open.
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/pause", { method: "POST", headers: auth("org_a"), body: "{}" }),
      );
      expect(res.status).toBe(403);
      // Provisioning still works on managed — that is how the first binding arrives.
      const bind = await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      expect(bind.status).toBe(200);
      const okPause = await handler(
        new Request("http://x/v1/tools/tool_1/pause", { method: "POST", headers: auth("org_a"), body: "{}" }),
      );
      expect(okPause.status).toBe(200);
    });
  });

  test("legacy unbound workspace keeps working in dev, with a warning", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined, EDEN_DEV: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedTool(store);
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
      try {
        const res = await handler(
          new Request("http://x/v1/tools/tool_1/pause", { method: "POST", headers: auth(), body: "{}" }),
        );
        expect(res.status).toBe(200);
      } finally {
        console.error = orig;
      }
      expect(errors.some((e) => e.includes("no org binding"))).toBe(true);
    });
  });

  test("read routes stay key-gated only", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedTool(store);
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      for (const path of ["/v1/inbox", "/v1/candidates", "/v1/receipts"]) {
        // Wrong org and no org both read fine — the gate is tenant writes, not reads.
        const wrong = await handler(new Request(`http://x${path}`, { headers: auth("org_b") }));
        expect(wrong.status).toBe(200);
        const bare = await handler(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
        expect(bare.status).toBe(200);
      }
    });
  });

  test("a second org cannot claim an already-bound workspace", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      const first = await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      expect(first.status).toBe(200);
      const steal = await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_b"),
          body: JSON.stringify({ org_id: "org_b" }),
        }),
      );
      // 409, not 403: the refusal now comes from the store's atomic claim
      // (the binding already exists and names a different org) rather than a
      // read-then-write pre-check that raced across processes.
      expect(steal.status).toBe(409);
      expect(((await steal.json()) as { error: string }).error).toBe("workspace not bound to this org");
      expect(store.orgsFor(Store.WORKSPACE_ID)).toEqual(["org_a"]);
      // Re-binding the same org is idempotent.
      const again = await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      expect(again.status).toBe(200);
    });
  });

  test("the first-bind claim itself is atomic", () => {
    const store = new Store(":memory:");
    // First bind wins…
    expect(store.bindOrg(Store.WORKSPACE_ID, "org_a")).toBe("bound");
    // …same org re-binds idempotently…
    expect(store.bindOrg(Store.WORKSPACE_ID, "org_a")).toBe("exists");
    // …and a different org loses even when it would have read "no binding"
    // in the old check-then-insert window (two processes sharing one DB).
    expect(store.bindOrg(Store.WORKSPACE_ID, "org_b")).toBe("conflict");
    expect(store.orgsFor(Store.WORKSPACE_ID)).toEqual(["org_a"]);
  });

  test("wrap-run carries the tenant gate", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedTool(store);
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      // Running a tool performs its third-party calls — state-changing, so a
      // foreign (or absent) org must not reach the executor.
      const wrong = await handler(
        new Request("http://x/v1/wrap-run", { method: "POST", headers: auth("org_b"), body: "{}" }),
      );
      expect(wrong.status).toBe(403);
      const noOrg = await handler(new Request("http://x/v1/wrap-run", { method: "POST", headers: auth(), body: "{}" }));
      expect(noOrg.status).toBe(403);
      // Nothing ran: no receipts were written for the tool.
      expect(store.receiptStats("tool_1").n).toBe(0);
    });
  });

  test("candidate shadow carries the tenant gate", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: TOKEN });
      seedApprovableCandidate(store);
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: auth("org_a"),
          body: JSON.stringify({ org_id: "org_a" }),
        }),
      );
      // Re-shadowing overwrites verdict/manifest/refusal — review state a
      // foreign org must not be able to rewrite or clear.
      const before = store.candidate("tool_1");
      const wrong = await handler(
        new Request("http://x/v1/candidates/tool_1/shadow", { method: "POST", headers: auth("org_b"), body: "{}" }),
      );
      expect(wrong.status).toBe(403);
      expect(store.candidate("tool_1")).toEqual(before);
      const noOrg = await handler(
        new Request("http://x/v1/candidates/tool_1/shadow", { method: "POST", headers: auth(), body: "{}" }),
      );
      expect(noOrg.status).toBe(403);
    });
  });

  test("a managed install never accepts the public dev credential", async () => {
    await withEnv({ DATABASE_URL: "postgres://managed", VERCEL: undefined, EDEN_DEV: undefined }, async () => {
      const store = new Store(":memory:");
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
      let handler: (req: Request) => Promise<Response>;
      try {
        handler = createHandler({ store, token: "eden_dev" });
      } finally {
        console.error = orig;
      }
      // The fallback was refused at construction, so every /v1 request —
      // including one bearing the literal every Eden deployment ships with —
      // gets 401 instead of a full read of all workspaces.
      const res = await handler(new Request("http://x/v1/tools", { headers: { authorization: "Bearer eden_dev" } }));
      expect(res.status).toBe(401);
      const chat = await handler(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev" },
          body: "{}",
        }),
      );
      expect(chat.status).toBe(401);
      expect(errors.some((e) => e.includes("refusing the public dev credential"))).toBe(true);
    });
  });

  test("the web plane sends x-eden-org end to end", async () => {
    await withEnv({ DATABASE_URL: undefined, VERCEL: undefined }, async () => {
      const store = new Store(":memory:");
      const handler = createHandler({ store, token: "eden_dev" });
      seedTool(store);
      // Simulate exactly what canvas/actions.ts plane() now sends after its Clerk gate.
      await handler(
        new Request("http://x/v1/workspace/orgs", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev", "content-type": "application/json", "x-eden-org": "org_zz" },
          body: JSON.stringify({ org_id: "org_zz" }),
        }),
      );
      const res = await handler(
        new Request("http://x/v1/tools/tool_1/pause", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev", "content-type": "application/json", "x-eden-org": "org_zz" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(200);
    });
  });
});
