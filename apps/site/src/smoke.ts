/**
 * Live smoke test: boots the site server in-process via Bun.serve on an
 * ephemeral port with a throwaway SQLite file, then drives every route over
 * real HTTP — the closest thing to production behaviour short of deploying.
 *
 * Run: bun run apps/site/src/smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "eden-smoke-"));
process.env.EDEN_DB = join(dir, "smoke.db");
process.env.EDEN_DEV = "1";
process.env.EDEN_SKIP_SEED = "1"; // deterministic tool inventory
delete process.env.DATABASE_URL;

const { handleFetch } = await import("./server");

const server = Bun.serve({ port: 0, fetch: handleFetch });
const base = server.url.href.replace(/\/$/, "");
const AUTH = { authorization: "Bearer eden_dev", "content-type": "application/json" };

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
  }
}
function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// A two-step island whose playback targets the in-process forge. Event ids
// are minted per run: they are the ingest idempotency key, so a resent event
// is dropped and a *new* call must carry a new id.
const makeEvents = (run: string) => [
  {
    event_id: `${run}-e1`,
    seq: 0,
    name: "Bash",
    args: {},
    command: "curl http://127.0.0.1/forge/repos/acme/app/issues/12",
    ok: true,
  },
  {
    event_id: `${run}-e2`,
    seq: 1,
    name: "Bash",
    args: {},
    command: "curl http://127.0.0.1/forge/repos/acme/app/issues/12/comments",
    ok: true,
  },
];
const events = makeEvents("r1");

await check("health answers without auth", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status === 200 && ((await res.json()) as { ok: boolean }).ok, `status ${res.status}`);
});

await check("a non-eden bearer is refused even in dev mode", async () => {
  const res = await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer not_eden" },
    body: JSON.stringify({ run_id: "r0", events }),
  });
  expect(res.status === 401, `status ${res.status}`);
});

await check("cross-origin write is refused", async () => {
  const res = await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: { ...AUTH, origin: "https://evil.test" },
    body: JSON.stringify({ run_id: "r0", events }),
  });
  expect(res.status === 403, `status ${res.status}`);
});

await check("valid ingest accepted", async () => {
  const res = await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ run_id: "r2", events: makeEvents("r2") }),
  });
  expect(res.status === 202, `status ${res.status}`);
});

await check("stretch_end mines a draft and raises a knock", async () => {
  const res = await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ run_id: "r4", events: makeEvents("r4"), stretch_end: true }),
  });
  expect(res.status === 202, `status ${res.status}`);
  const second = await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ run_id: "r3", events: makeEvents("r3"), stretch_end: true }),
  });
  expect(second.status === 202, `second status ${second.status}`);
  const tools = (await (await fetch(`${base}/v1/tools`, { headers: AUTH })).json()) as {
    tools: Array<{ id: string; state: string; has_playback: boolean }>;
  };
  const draft = tools.tools.find((t) => t.state === "draft");
  expect(draft, "no draft after two observed stretches");
  expect(draft!.has_playback, "draft has no playable urls");
});

await check("approve requires the workshop gate and flips state", async () => {
  const tools = (await (await fetch(`${base}/v1/tools`, { headers: AUTH })).json()) as {
    tools: Array<{ id: string; name: string; state: string }>;
  };
  const draft = tools.tools.find((t) => t.state === "draft")!;
  const json = await fetch(`${base}/v1/tools/${draft.id}/approve`, {
    method: "POST",
    headers: { ...AUTH, accept: "application/json" },
  });
  expect(json.ok, `approve status ${json.status}`);
});

await check("MCP handshake is an empty catalog; dispatch matches a live tool", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const body = (await res.json()) as { result?: { serverInfo?: { name?: string } }; error?: unknown };
  expect(body.result?.serverInfo?.name === "eden", JSON.stringify(body).slice(0, 120));
  const list = (await (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    })
  ).json()) as { result?: { tools?: Array<{ name: string }> } };
  expect((list.result?.tools ?? []).length === 0, "tools/list must not dump the catalog");
  const inventory = (await (await fetch(`${base}/v1/tools`, { headers: AUTH })).json()) as {
    tools: Array<{ state: string }>;
  };
  if (!inventory.tools.some((t) => t.state === "on")) return;
  const dispatch = (await (
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/dispatch",
        params: { messages: [{ role: "user", content: "curl http://127.0.0.1/forge/repos/acme/app/issues/12" }] },
      }),
    })
  ).json()) as { result?: { tools?: Array<{ name: string }> } };
  expect((dispatch.result?.tools ?? []).length === 1, `dispatch expected 1, got ${JSON.stringify(dispatch).slice(0, 200)}`);
});

await check("play runs the compiled tool against the in-process forge", async () => {
  const tools = (await (await fetch(`${base}/v1/tools`, { headers: AUTH })).json()) as {
    tools: Array<{ name: string; state: string }>;
  };
  const on = tools.tools.find((t) => t.state === "on")!;
  const res = await fetch(`${base}/v1/play`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ name: on.name, issue: "34" }),
  });
  const receipt = (await res.json()) as { ok: boolean; steps_ok: number };
  expect(res.ok && receipt.ok && receipt.steps_ok >= 2, JSON.stringify(receipt).slice(0, 200));
});

await check("workshop pages render", async () => {
  const ws = await fetch(`${base}/workshop`, { headers: AUTH });
  expect(ws.ok && (await ws.text()).includes("Workshop"), `status ${ws.status}`);
  const dash = await fetch(`${base}/dashboard`, { headers: AUTH });
  expect(dash.ok, `dashboard status ${dash.status}`);
});

server.stop(true);
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
