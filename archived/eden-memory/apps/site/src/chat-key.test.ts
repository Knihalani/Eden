import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import * as edenMem from "../../../src/index";

/**
 * #88: the site's chat route passed the operator's OPENAI_API_KEY upstream for any caller a dev
 * host lets into ws_local, and `bun run dev` (local.ts) listened on every interface. So any device
 * on the network, or another account on the machine, could spend that key with no credential.
 *
 * Mirrors #84 in apps/control: a caller pays with its own provider key. The operator's key is used
 * only for a caller that authenticated the way a real deployment requires.
 */
const OPERATOR_KEY = "sk-operator-openai-key-0001";
const CALLER_KEY = "sk-caller-own-key-0002";

const ENV = [
  "DATABASE_URL",
  "VERCEL",
  "EDEN_DEV",
  "EDEN_DB",
  "EDEN_SKIP_SEED",
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

/** Every Authorization header the fake model provider received. */
const upstreamAuth: Array<string | null> = [];
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    upstreamAuth.push(req.headers.get("authorization"));
    if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    });
  },
});

const dir = mkdtempSync(join(tmpdir(), "eden-chat-key-"));
// Cache-bust so this file owns its server and database singleton (see signup.test.ts).
const SERVER_MOD = `./server?bust=chat-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let handleFetch: (req: Request) => Promise<Response>;
const ipBase = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.`;
let ipSeq = 0;

/** A laptop running `bun run dev`: not managed, dev fallback on. */
function devHost() {
  for (const k of ["DATABASE_URL", "VERCEL", "EDEN_DEV"]) delete process.env[k];
}

beforeAll(async () => {
  devHost();
  process.env.EDEN_DB = join(dir, "site.db");
  // No seeded tool: a keyless caller must not be answered by playing one either.
  process.env.EDEN_SKIP_SEED = "1";
  process.env.OPENAI_API_KEY = OPERATOR_KEY;
  process.env.OPENAI_API_BASE = `http://127.0.0.1:${upstream.port}/v1`;
  ({ handleFetch } = await import(SERVER_MOD));
  // Open the database as a laptop does, whichever test runs first, so eden_dev is seeded.
  await (await handleFetch(new Request("http://127.0.0.1:8787/health"))).text();
});

beforeEach(() => {
  devHost();
  upstreamAuth.length = 0;
});

afterAll(() => {
  upstream.stop(true);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function chat(headers: Record<string, string>, stream = false): Promise<Response> {
  return handleFetch(
    new Request("http://127.0.0.1:8787/v1/chat/completions", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "gpt-4o", stream, messages: [{ role: "user", content: "Reply with pong." }] }),
    }),
  );
}

async function signupKey(): Promise<string> {
  const res = await handleFetch(
    new Request("http://127.0.0.1:8787/v1/signup", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json", "x-real-ip": `${ipBase}${++ipSeq}` },
      body: JSON.stringify({ name: "chat-key" }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { api_key: string }).api_key;
}

describe("the site chat route never spends the operator's key for a caller it cannot tell apart (#88)", () => {
  test("a dev host refuses every keyless caller before any upstream call", async () => {
    // No credential, the public dev key, and a key anyone who reaches the port can mint.
    const signup = await signupKey();
    const callers: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer eden_dev" },
      { "x-eden-api-key": signup },
    ];
    const statuses: number[] = [];
    for (const headers of callers) {
      const res = await chat(headers);
      await res.text();
      statuses.push(res.status);
    }
    expect(upstreamAuth).toEqual([]);
    expect(statuses).toEqual([401, 401, 401]);
  });

  test("the public dev key does not spend the operator's key on an EDEN_DEV=0 host either", async () => {
    process.env.EDEN_DEV = "0";
    // It still authenticates there (its row is seeded on every unmanaged host)...
    const api = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/openapi.json", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(api.status).toBe(200);
    // ...but /v1/setup hands it to anyone, so it does not show the caller is the operator.
    const res = await chat({ authorization: "Bearer eden_dev" });
    await res.text();
    expect(upstreamAuth).toEqual([]);
    expect(res.status).toBe(401);
  });

  test("a signed-up key without a provider key does not spend the operator's key on an EDEN_DEV=0 host (#91)", async () => {
    process.env.VERCEL = "1";
    let key: string;
    try {
      key = await signupKey();
    } finally {
      delete process.env.VERCEL;
    }
    process.env.EDEN_DEV = "0";
    const res = await chat({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("provider_key_required");
    expect(upstreamAuth).toEqual([]);
  });

  test("a caller's own provider key is forwarded as itself, plain and streaming", async () => {
    const plain = await chat({ authorization: `Bearer ${CALLER_KEY}` });
    expect(plain.status).toBe(200);
    const body = (await plain.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(body.choices?.[0]?.message?.content).toBe("pong");
    await (await chat({ authorization: `Bearer ${CALLER_KEY}` }, true)).text();
    // The documented setup: provider key as Authorization, Eden key as x-eden-api-key.
    await (await chat({ authorization: `Bearer ${CALLER_KEY}`, "x-eden-api-key": "eden_dev" })).text();
    await (await chat({ "x-openai-api-key": CALLER_KEY })).text();
    expect(upstreamAuth).toEqual(Array(4).fill(`Bearer ${CALLER_KEY}`));
  });

  describe("managed deployment", () => {
    beforeEach(() => {
      process.env.VERCEL = "1";
    });

    afterEach(() => {
      delete process.env.VERCEL;
    });

    test("an unauthenticated caller is still refused", async () => {
      const res = await chat({});
      await res.text();
      expect(res.status).toBe(401);
      expect(upstreamAuth).toEqual([]);
    });

    test("a signed-up workspace key without a provider key is refused: anyone can sign up (#91)", async () => {
      const key = await signupKey();
      const res = await chat({ authorization: `Bearer ${key}` });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("provider_key_required");
      await (await chat({ "x-eden-api-key": key }, true)).text();
      expect(upstreamAuth).toEqual([]);
    });

    test("a signed-up caller that sends its own provider key pays with it", async () => {
      const key = await signupKey();
      await (await chat({ authorization: `Bearer ${CALLER_KEY}`, "x-eden-api-key": key })).text();
      expect(upstreamAuth).toEqual([`Bearer ${CALLER_KEY}`]);
    });
  });
});

const LOCAL = join(import.meta.dir, "local.ts");
/** An address of this machine that another device on the network could connect to. */
const LAN_ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return port;
}

async function reachable(host: string, port: number): Promise<boolean> {
  try {
    await (await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2000) })).text();
    return true;
  } catch {
    return false;
  }
}

/** Starts `bun run dev` (local.ts) and returns its boot line once loopback answers. */
async function bootLocal(port: number, extra: Record<string, string>) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    EDEN_DB: join(dir, `local-${port}.db`),
    EDEN_SKIP_SEED: "1",
    DATABASE_URL: "",
    VERCEL: "",
  };
  delete env.EDEN_SITE_HOST;
  // cwd is a temp dir so Bun does not load a developer's .env into the child.
  const proc = Bun.spawn(["bun", LOCAL], { cwd: dir, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 100 && !(await reachable("127.0.0.1", port)); i++) await Bun.sleep(100);
  return { proc, stop: () => proc.kill() };
}

describe("the site chat route reads and writes no process memory (#89)", () => {
  // One process store would be shared by every workspace on a deployment, and on a dev host by
  // every caller that gets into ws_local. The site has no operator whose memory it could be.
  const memory = spyOn(edenMem, "processMemory");

  beforeEach(() => {
    memory.mockClear();
  });

  afterAll(() => {
    memory.mockRestore();
  });

  test("a dev host: a caller paying with its own key, plain and streaming", async () => {
    expect((await chat({ authorization: `Bearer ${CALLER_KEY}` })).status).toBe(200);
    await (await chat({ authorization: `Bearer ${CALLER_KEY}` }, true)).text();
    expect(upstreamAuth).toEqual(Array(2).fill(`Bearer ${CALLER_KEY}`));
    expect(memory).not.toHaveBeenCalled();
  });

  test("a managed deployment: a signed-up workspace paying with its own key", async () => {
    process.env.VERCEL = "1";
    try {
      const key = await signupKey();
      expect((await chat({ authorization: `Bearer ${CALLER_KEY}`, "x-eden-api-key": key })).status).toBe(200);
    } finally {
      delete process.env.VERCEL;
    }
    expect(upstreamAuth).toEqual([`Bearer ${CALLER_KEY}`]);
    expect(memory).not.toHaveBeenCalled();
  });
});

describe("local.ts binds loopback unless told otherwise (#88)", () => {
  test("by default it answers on 127.0.0.1 and not on the machine's network address", async () => {
    const port = freePort();
    const { proc, stop } = await bootLocal(port, {});
    try {
      expect(await reachable("127.0.0.1", port)).toBe(true);
      if (LAN_ADDRESS) expect(await reachable(LAN_ADDRESS, port)).toBe(false);
    } finally {
      stop();
      await proc.exited;
    }
    expect(await new Response(proc.stdout).text()).toContain(`Eden local http://127.0.0.1:${port}/`);
  });

  test("EDEN_SITE_HOST=0.0.0.0 opts into a LAN bind", async () => {
    const port = freePort();
    const { proc, stop } = await bootLocal(port, { EDEN_SITE_HOST: "0.0.0.0" });
    try {
      expect(await reachable("127.0.0.1", port)).toBe(true);
      if (LAN_ADDRESS) expect(await reachable(LAN_ADDRESS, port)).toBe(true);
    } finally {
      stop();
      await proc.exited;
    }
    expect(await new Response(proc.stdout).text()).toContain(`Eden local http://0.0.0.0:${port}/`);
  });
});
