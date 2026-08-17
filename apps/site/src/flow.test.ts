import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import { ingest } from "./cluster";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import type { ToolEvent } from "@eden/core";

function ev(i: number, command: string): ToolEvent {
  return {
    event_id: `e${i}-${command}-${Date.now()}`,
    seq: i,
    name: "Bash",
    args: { command },
    command,
    ok: true,
  };
}

describe("ingest → draft → approve → play", () => {
  const dbP = openDb(`/tmp/eden-int-${Date.now()}.db`);
  afterAll(async () => {
    /* file db */
  });

  test("silent draft on run 1, knock on run 2", async () => {
    const db = await dbP;
    const island = [
      ev(1, "gh pr view 12 --json title"),
      ev(2, "curl https://api.github.com/repos/acme/app/issues/12/comments"),
      ev(3, "gh api repos/acme/app/commits/abc/status"),
    ];
    const a = await ingest(db, "ws_local", "run1", island, true);
    expect(a.islands).toBe(1);
    const draft = await db.get<{ state: string }>(
      `SELECT state FROM tool WHERE fingerprint IS NOT NULL AND name != 'fetch_issue_bundle'`,
    );
    expect(draft?.state).toBe("draft");
    const b = await ingest(
      db,
      "ws_local",
      "run2",
      island.map((e, i) => ({ ...e, event_id: e.event_id + "b", seq: i })),
      true,
    );
    expect(b.islands).toBe(1);
    const knock = await db.get<{ attempt: number }>(`SELECT attempt FROM knock LIMIT 1`);
    expect(knock?.attempt).toBe(1);
  });

  test("re-ingest of the same run_id does not inflate cluster count", async () => {
    const db = await openDb(`/tmp/eden-dup-${Date.now()}.db`);
    const island = [
      ev(1, "curl https://api.github.com/repos/acme/app/issues/1"),
      ev(2, "curl https://api.github.com/repos/acme/app/issues/1/comments"),
    ];
    await ingest(db, "ws_local", "same", island, true);
    await ingest(db, "ws_local", "same", island, true);
    const cluster = await db.get<{ count: number }>(`SELECT count FROM cluster LIMIT 1`);
    expect(cluster?.count).toBe(1);
    const knocks = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM knock`);
    expect(knocks?.c).toBe(0);
  });

  test("compiled gh pull+status binds sha from the pull", async () => {
    const db = await openDb(`/tmp/eden-bind-sha-${Date.now()}.db`);
    const island = [
      ev(1, "gh api repos/KaiavN/Eden/pulls/12"),
      ev(2, "gh api repos/KaiavN/Eden/pulls/12/reviews"),
      ev(3, "gh api repos/KaiavN/Eden/commits/abc123def/status"),
    ];
    await ingest(db, "ws_local", "bindsha", island, true);
    const tool = await db.get<{ steps: string }>(`SELECT steps FROM tool LIMIT 1`);
    const steps = JSON.parse(tool!.steps) as Array<{ url?: string; bind?: Record<string, string> }>;
    expect(steps[2].url).toContain("/commits/{sha}/status");
    expect(steps[2].bind?.sha).toBe("{{s1.head.sha}}");
    expect(steps.some((s) => /\/files$/.test(s.url || ""))).toBe(true);
  });

  test("second github_pr_bundle fingerprint updates the first tool", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    const db = await openDb(`/tmp/eden-bundle-merge-${Date.now()}.db`);
    const a = [
      ev(1, "gh api repos/KaiavN/Eden/pulls/12"),
      ev(2, "gh api repos/KaiavN/Eden/pulls/12/reviews"),
      ev(3, "gh api repos/KaiavN/Eden/commits/abc123def/status"),
    ];
    const b = [
      ev(1, "gh api repos/KaiavN/Eden/pulls/99"),
      ev(2, "gh api repos/KaiavN/Eden/pulls/99/reviews"),
      ev(3, "gh api repos/KaiavN/Eden/commits/ffffffffffffffff/status"),
      ev(4, "gh api repos/KaiavN/Eden/pulls/99/files"),
    ];
    await ingest(db, "ws_local", "run-a", a, true);
    await ingest(db, "ws_local", "run-b", b, true);
    delete process.env.EDEN_AUTO_APPROVE;
    const tools = await db.all<{ name: string }>(`SELECT name FROM tool WHERE name LIKE 'github_pr_bundle%'`);
    expect(tools.map((t) => t.name)).toEqual(["github_pr_bundle"]);
  });

  test("EDEN_AUTO_APPROVE turns a playable draft On", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    const db = await openDb(`/tmp/eden-auto-on-${Date.now()}.db`);
    const island = [
      ev(1, "gh api repos/KaiavN/Eden/pulls/12"),
      ev(2, "gh api repos/KaiavN/Eden/pulls/12/reviews"),
      ev(3, "gh api repos/KaiavN/Eden/commits/abc123def/status"),
    ];
    await ingest(db, "ws_local", "auto", island, true);
    const tool = await db.get<{ name: string; state: string; published: number }>(
      `SELECT name, state, published FROM tool LIMIT 1`,
    );
    delete process.env.EDEN_AUTO_APPROVE;
    expect(tool?.name).toBe("github_pr_bundle");
    expect(tool?.state).toBe("on");
    expect(tool?.published).toBe(1);
  });

  test("pull-only stretch compiles a full github_pr_bundle", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    const db = await openDb(`/tmp/eden-pull-only-${Date.now()}.db`);
    await ingest(
      db,
      "ws_local",
      "pull-only",
      [
        ev(1, "gh api repos/KaiavN/Eden/pulls/12"),
        ev(2, "gh api repos/KaiavN/Eden/pulls/12/reviews"),
      ],
      true,
    );
    delete process.env.EDEN_AUTO_APPROVE;
    const tool = await db.get<{ name: string; steps: string }>(`SELECT name, steps FROM tool LIMIT 1`);
    expect(tool?.name).toBe("github_pr_bundle");
    const steps = JSON.parse(tool!.steps) as Array<{ url?: string; bind?: Record<string, string> }>;
    expect(steps.some((s) => /\/pulls\/\{issue\}$/.test(s.url || ""))).toBe(true);
    expect(steps.some((s) => /\/reviews/.test(s.url || ""))).toBe(true);
    expect(steps.some((s) => /\/status/.test(s.url || ""))).toBe(true);
    expect(steps.some((s) => /\/files/.test(s.url || ""))).toBe(true);
    expect(steps.find((s) => /\/status/.test(s.url || ""))?.bind?.sha).toBe("{{s1.head.sha}}");
    const watched = await db.all<{ issue: string }>(`SELECT issue FROM watched_issue ORDER BY issue`);
    expect(watched.map((r) => r.issue)).toEqual(["12"]);
  });

  test("playTool issues[] returns one table for two forge PRs", async () => {
    const db = await openDb(`/tmp/eden-batch-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'github_pr_bundle', 'x', 'on', ?, '[]', 'fp-batch')`,
      [
        crypto.randomUUID(),
        JSON.stringify([
          { id: "s1", kind: "cloud_http", name: "pull", commute: true, url: "http://127.0.0.1/forge/repos/acme/app/pulls/{issue}" },
          { id: "s2", kind: "cloud_http", name: "reviews", commute: true, url: "http://127.0.0.1/forge/repos/acme/app/pulls/{issue}/reviews" },
          {
            id: "s3",
            kind: "cloud_http",
            name: "status",
            commute: true,
            url: "http://127.0.0.1/forge/repos/acme/app/commits/{sha}/status",
            bind: { sha: "{{s1.head.sha}}" },
          },
        ]),
      ],
    );
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'github_pr_bundle'`,
    );
    const receipt = await playTool(db, tool!, { issues: "12,13" });
    expect(receipt.ok).toBe(true);
    expect(receipt.table).toContain("Fix deploy for 12");
    expect(receipt.table).toContain("Fix deploy for 13");
    expect(receipt.table!.split("\n").length).toBe(2);
    expect(receipt.rows?.map((r) => r.number)).toEqual([12, 13]);
    expect(receipt.rows?.every((r) => typeof r.reviews === "number")).toBe(true);
    expect(receipt.rows?.every((r) => /^(success|failure|pending|error)$/.test(r.status))).toBe(true);
  });
});

describe("playback densify + cache + parallel", () => {
  test("play seeded-shaped tool against live forge", async () => {
    const origin = process.env.EDEN_ORIGIN;
    if (!origin) return;
    const db = await openDb();
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'fetch_issue_bundle'`,
    );
    if (!tool) return;
    const receipt = await playTool(db, tool, { issue: "12", origin });
    expect(receipt.ok).toBe(true);
    expect(receipt.steps_attempted).toBe(6);
    expect(receipt.densified_bytes).toBeLessThan(receipt.raw_bytes);
    expect(receipt.facts).toBeTruthy();
  });
});

describe("forge routing", () => {
  test("does not intercept real GitHub API hosts", () => {
    expect(handleForge(new URL("https://api.github.com/repos/KaiavN/Eden/pulls/168"))).toBeNull();
    expect(handleForge(new URL("http://127.0.0.1:8791/forge/repos/acme/app/pulls/12"))).not.toBeNull();
  });

  test("serves generic shop REST resources", async () => {
    const order = handleForge(new URL("http://127.0.0.1/shop/orders/11"));
    expect(order).not.toBeNull();
    const body = await order!.json();
    expect(body).toEqual({ id: 11, title: "Order 11", total: 115, status: "open" });
    const items = await handleForge(new URL("http://127.0.0.1/shop/orders/11/items"))!.json();
    expect(items).toHaveLength(2);
  });
});

describe("approve is workspace-gated", () => {
  test("Vercel production rejects unauthenticated approve", async () => {
    const prev = {
      VERCEL: process.env.VERCEL,
      EDEN_DEV: process.env.EDEN_DEV,
      EDEN_DB: process.env.EDEN_DB,
      EDEN_AUTO_APPROVE: process.env.EDEN_AUTO_APPROVE,
    };
    process.env.VERCEL = "1";
    process.env.EDEN_DEV = "0";
    process.env.EDEN_DB = `/tmp/eden-approve-${Date.now()}.db`;
    delete process.env.EDEN_AUTO_APPROVE;
    try {
      const { handleFetch } = await import("./server");
      const res = await handleFetch(new Request("http://127.0.0.1/v1/tools/nope/approve", { method: "POST" }));
      expect(res.status).toBe(401);
    } finally {
      process.env.VERCEL = prev.VERCEL;
      process.env.EDEN_DEV = prev.EDEN_DEV;
      process.env.EDEN_DB = prev.EDEN_DB;
      process.env.EDEN_AUTO_APPROVE = prev.EDEN_AUTO_APPROVE;
    }
  });
});

describe("product wrap matches seen names", () => {
  test("findOnTool hits seen, not only compiled name", async () => {
    const db = await openDb(`/tmp/eden-wrap-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'issue_bundle', 'use it', 'on', ?, ?, 'fp')`,
      [
        crypto.randomUUID(),
        JSON.stringify([{ id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "http://example.invalid/{issue}" }]),
        JSON.stringify(["get_issue", "list_comments"]),
      ],
    );
    const { findOnTool } = await import("./wrap");
    const hit = await findOnTool(db, "ws_local", "get_issue");
    expect(hit?.name).toBe("issue_bundle");
    const miss = await findOnTool(db, "ws_local", "unrelated");
    expect(miss).toBeUndefined();
  });
});

describe("runner fail-closed", () => {
  test("unbound runner step fails the receipt", async () => {
    const db = await openDb(`/tmp/eden-runner-${Date.now()}.db`);
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'local_only', 'x', 'on', ?, '[]', 'fp')`,
      [
        crypto.randomUUID(),
        JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }]),
      ],
    );
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'local_only'`,
    );
    const receipt = await playTool(db, tool!, { origin: "http://127.0.0.1" });
    expect(receipt.ok).toBe(false);
    expect(receipt.steps_ok).toBe(0);
  });
});

describe("wrap cache", () => {
  test("failed play is not cached as ok", async () => {
    const db = await openDb(`/tmp/eden-wrap-cache-${Date.now()}.db`);
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'local_only', 'x', 'on', ?, '[]', 'fp')`,
      [id, JSON.stringify([{ id: "s1", kind: "runner", name: "git.status", commute: true }])],
    );
    const { wrapPlay } = await import("./wrap");
    const tool = { id, name: "local_only", steps: JSON.stringify([{ id: "s1", kind: "runner", name: "git.status" }]), seen: "[]" };
    const a = await wrapPlay(db, tool, {}, "http://127.0.0.1", "run-fail");
    const b = await wrapPlay(db, tool, {}, "http://127.0.0.1", "run-fail");
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    const cached = await db.get<{ c: number }>(`SELECT COUNT(*) as c FROM wrap_cache`);
    expect(cached?.c).toBe(0);
  });
});

describe("playback bind", () => {
  test("step.bind and {{s1.field}} fill the next URL", async () => {
    const db = await openDb(`/tmp/eden-bind-${Date.now()}.db`);
    const origin = "http://127.0.0.1:8787";
    await db.run(
      `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint)
       VALUES (?, 'ws_local', 'bound', 'x', 'on', ?, '[]', 'fp')`,
      [
        crypto.randomUUID(),
        JSON.stringify([
          { id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "{origin}/forge/repos/acme/app/issues/{issue}" },
          {
            id: "s2",
            kind: "cloud_http",
            name: "comments",
            commute: true,
            url: "{origin}/forge/repos/acme/app/issues/{{s1.number}}/comments",
            bind: { issue: "{{s1.number}}" },
          },
        ]),
      ],
    );
    const tool = await db.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = 'bound'`,
    );
    const receipt = await playTool(db, tool!, { issue: "12", origin });
    expect(receipt.ok).toBe(true);
    expect(receipt.steps_ok).toBe(2);
  });

  test("curl shop traces compile a playable shop_orders tool", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    const db = await openDb(`/tmp/eden-shop-${Date.now()}.db`);
    const island = [
      ev(1, "curl http://127.0.0.1/shop/orders/11"),
      ev(2, "curl http://127.0.0.1/shop/orders/11/items"),
    ];
    await ingest(db, "ws_local", "shop1", island, true);
    delete process.env.EDEN_AUTO_APPROVE;
    const tool = await db.get<{ id: string; name: string; state: string; steps: string }>(
      `SELECT id, name, state, steps FROM tool LIMIT 1`,
    );
    expect(tool?.name).toBe("shop_orders");
    expect(tool?.state).toBe("on");
    const steps = JSON.parse(tool!.steps) as Array<{ url?: string }>;
    expect(steps.some((s) => s.url?.includes("/shop/orders/{id}"))).toBe(true);
    expect(steps.some((s) => s.url?.endsWith("/items"))).toBe(true);
    const receipt = await playTool(db, tool!, { ids: "11,12" });
    expect(receipt.ok).toBe(true);
    expect(receipt.facts && typeof receipt.facts === "object").toBe(true);
    const rows = (receipt.facts as { rows?: Array<{ s1?: { title?: string; total?: number } }> }).rows;
    expect(rows?.map((r) => r.s1?.title)).toEqual(["Order 11", "Order 12"]);
    expect(rows?.every((r) => typeof r.s1?.total === "number")).toBe(true);
  });

  test("customers and orders compile as separate tools", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    const db = await openDb(`/tmp/eden-shop-multi-${Date.now()}.db`);
    await ingest(
      db,
      "ws_local",
      "orders",
      [ev(1, "curl http://127.0.0.1/shop/orders/11"), ev(2, "curl http://127.0.0.1/shop/orders/11/items")],
      true,
    );
    await ingest(
      db,
      "ws_local",
      "customers",
      [ev(1, "curl http://127.0.0.1/shop/customers/21"), ev(2, "curl http://127.0.0.1/shop/customers/21/orders")],
      true,
    );
    delete process.env.EDEN_AUTO_APPROVE;
    const names = (await db.all<{ name: string }>(`SELECT name FROM tool ORDER BY name`)).map((t) => t.name);
    expect(names).toEqual(["shop_customers", "shop_orders"]);
  });
});
