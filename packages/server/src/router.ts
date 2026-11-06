/**
 * The multi-process router (D113 stage 1, D163): one Bun.serve front and N child server processes (`main.ts` with
 * EDEN_ROUTER_CHILD="i/N"), started when EDEN_PROCESSES is above 1. Every piece of per-user state (cache, sessions,
 * budgets, reader and card caches, sync) lives in the one process that serves the user, so the engine's work spreads
 * over cores only if each user always reaches the same process: the router sends each request to child
 * `childFor(tenant, userId, N)`, a stable hash of the tenant (from the API key, as http.ts reads it) and the body's
 * `userId`. Sticky by construction: no table, nothing to keep or forget here, and `/v1/forget` reaches the child that
 * holds the user's state.
 *
 * What changes with N children (D163), each in the child, not here:
 * - each child has its own source-map file (`childSourceMapPath`), since one SQLite file must have one writer;
 * - each child holds 1/N of every per-tenant cap: the GCRA rate and burst (`loadConfig`) and the daily model spend
 *   (`buildPartner`'s `processes`). A tenant whose users hash unevenly reaches its cap sooner on the busier child.
 *
 * Failure: a child that is down (exited, not yet restarted, or refusing the connection) gives its users 503
 * `{error}` ("temporarily unable to serve context", what an integration treats as silence), never a 500, while the
 * other children keep serving. An exited child is started again after `restartMs` (doubling to 30 s while it keeps
 * failing); its users' in-memory state is gone, as after any restart (D8), and its source-map file is reopened.
 * `/healthz` answers here: 200 when every child is up, 503 naming how many are.
 *
 * The router reads each POST body once to find `userId` (a `JSON.parse` the child repeats; router.bench.ts measures
 * the hop) and forwards the bytes unchanged with the `authorization` and `content-type` headers. A declared
 * content-length past `maxBodyBytes` is refused here with the handler's 413 (D100) so it is never buffered twice;
 * every other answer, auth, rate limit and validation included, is the child's.
 */
import { fileURLToPath } from "node:url";
import { fnv1a, mix32 } from "@eden/primitives";
import { childSourceMapPath, DEFAULT_MAX_BODY_BYTES, type ServerConfig } from "./config";

/** The child a tenant/user is served by: stable across restarts and router instances, spread by a mixed FNV-1a. */
export function childFor(tenant: string, userId: string, children: number): number {
  if (children <= 1) return 0;
  const key = `${tenant}/${userId}`;
  return mix32(fnv1a(key, 0, key.length)) % children;
}

/**
 * The top-level `userId` of a JSON body, or "" when there is none (not JSON, not an object, no string userId). A
 * full parse, not a scan: a nested `"userId"` (inside an item's `meta`, say) must not route a request. Requests
 * without one go to the tenant's own child, where the handler refuses them with its usual 400.
 */
export function userOf(body: Uint8Array): string {
  if (body.byteLength === 0) return "";
  try {
    const parsed: unknown = JSON.parse(decoder.decode(body));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const user = (parsed as Record<string, unknown>).userId;
      if (typeof user === "string") return user;
    }
  } catch {
    // Not JSON, or nested past the parser's depth: the child answers it with its 400.
  }
  return "";
}

const decoder = new TextDecoder();
const UNAVAILABLE = "temporarily unable to serve context";
const MAX_RESTART_MS = 30_000;

export interface RouterOptions {
  /** The router's own configuration (`loadConfig`): port, host, keys, dev, body cap, source-map base, processes. */
  config: Pick<ServerConfig, "port" | "host" | "keys" | "dev" | "sourceMapPath" | "processes"> &
    Partial<Pick<ServerConfig, "maxBodyBytes">>;
  /** The environment each child starts from (default `process.env`); the router sets its own variables over it. */
  env?: Record<string, string | undefined>;
  /** The child entry (default `main.ts` beside this file). */
  entry?: string;
  /** Wait before an exited child is started again; default 1,000 ms, doubled while it keeps failing to start. */
  restartMs?: number;
  /** How long the first start of every child may take; default 30 s. */
  startTimeoutMs?: number;
  /** Receives each child's stdout (tests, the bench); unset, children write to the router's stdout. */
  onOutput?: (index: number, text: string) => void;
  /** Operational lines (a child exited, restarted); default stderr. */
  log?: (line: string) => void;
}

export interface ChildState {
  readonly index: number;
  pid: number;
  /** The child's listening port on 127.0.0.1, or 0 while it is down. */
  port: number;
  up: boolean;
}

export interface Router {
  readonly port: number;
  readonly hostname: string;
  readonly children: readonly ChildState[];
  /** Stops routing and every child (SIGTERM, then SIGKILL after 2 s). */
  stop(): Promise<void>;
}

interface Child extends ChildState {
  proc: ReturnType<typeof Bun.spawn> | null;
  restartMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Starts N children, waits until each listens, then serves. Rejects (stopping them all) if any fails to start. */
export async function startRouter(options: RouterOptions): Promise<Router> {
  const { config } = options;
  const n = config.processes;
  const env = options.env ?? process.env;
  const entry = options.entry ?? fileURLToPath(new URL("./main.ts", import.meta.url));
  const baseRestartMs = options.restartMs ?? 1_000;
  const log = options.log ?? console.error;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tooLarge = `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`;
  let stopping = false;

  const children: Child[] = Array.from({ length: n }, (_, index) => ({
    index,
    pid: 0,
    port: 0,
    up: false,
    proc: null,
    restartMs: baseRestartMs,
    timer: null,
  }));

  // Each start resolves when the child reports its port, rejects if it exits first.
  const spawn = (c: Child): Promise<void> =>
    new Promise((resolve, reject) => {
      const childEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
      delete childEnv.EDEN_PROCESSES;
      Object.assign(childEnv, {
        PORT: "0",
        HOST: "127.0.0.1",
        EDEN_ROUTER_CHILD: `${c.index}/${n}`,
        EDEN_SOURCE_MAP: childSourceMapPath(config.sourceMapPath, c.index),
      });
      let ready = false;
      const proc = Bun.spawn([process.execPath, entry], {
        env: childEnv,
        stdin: "ignore",
        stdout: options.onOutput ? "pipe" : "inherit",
        stderr: "inherit",
        ipc(message) {
          const port = (message as { edenListening?: unknown } | null)?.edenListening;
          if (ready || typeof port !== "number") return;
          ready = true;
          c.port = port;
          c.up = true;
          c.restartMs = baseRestartMs;
          resolve();
        },
      });
      c.proc = proc;
      c.pid = proc.pid;
      if (options.onOutput && proc.stdout instanceof ReadableStream) void pipeOut(proc.stdout, c.index);
      void proc.exited.then((code) => {
        if (c.proc !== proc) return;
        c.up = false;
        c.port = 0;
        c.proc = null;
        if (!ready) reject(new Error(`eden router: child ${c.index} exited with code ${code} before listening`));
        if (stopping) return;
        log(
          `eden router: child ${c.index} (pid ${proc.pid}) exited with code ${code}; restarting in ${c.restartMs} ms`,
        );
        const wait = c.restartMs;
        c.restartMs = Math.min(MAX_RESTART_MS, c.restartMs * 2);
        c.timer = setTimeout(() => {
          c.timer = null;
          if (!stopping) spawn(c).catch(() => {}); // A failed restart logs from its own exit and is retried.
        }, wait);
      });
    });

  const pipeOut = async (stream: ReadableStream<Uint8Array>, index: number) => {
    const text = new TextDecoder();
    for await (const chunk of stream) options.onOutput!(index, text.decode(chunk, { stream: true }));
  };

  const stopChildren = async () => {
    stopping = true;
    await Promise.all(
      children.map(async (c) => {
        if (c.timer) clearTimeout(c.timer);
        const proc = c.proc;
        if (!proc) return;
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
        await proc.exited;
        clearTimeout(killer);
      }),
    );
  };

  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("eden router: children did not start in time")),
        options.startTimeoutMs ?? 30_000,
      );
    });
    await Promise.race([Promise.all(children.map(spawn)), timeout]).finally(() => clearTimeout(deadline));
  } catch (e) {
    await stopChildren();
    throw e;
  }

  const tenantOf = (req: Request): string | null => {
    const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    return config.dev && !key ? "dev" : null;
  };
  const fail = (status: number, error: string) => Response.json({ error }, { status });

  const forward = async (c: Child, req: Request, url: URL, body: Uint8Array | undefined): Promise<Response> => {
    if (!c.up) return fail(503, UNAVAILABLE);
    const headers: Record<string, string> = {};
    const auth = req.headers.get("authorization");
    if (auth !== null) headers.authorization = auth;
    const type = req.headers.get("content-type");
    if (type !== null) headers["content-type"] = type;
    try {
      return await fetch(`http://127.0.0.1:${c.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
    } catch {
      // Refused or reset: the child died under this request, or between its exit and the router hearing of it.
      return fail(503, UNAVAILABLE);
    }
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // The same cap as each child's (D100): a chunked body past it is refused before it is buffered here.
    maxRequestBodySize: maxBodyBytes,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        const up = children.filter((c) => c.up).length;
        if (up === n) return Response.json({ ok: true, processes: n, up });
        return Response.json(
          { ok: false, processes: n, up, error: `${n - up} of ${n} processes down` },
          { status: 503 },
        );
      }
      const tenant = tenantOf(req);
      // Only an authenticated POST is read for its user; anything else gets the child's own answer (405, 401).
      if (req.method !== "POST" || tenant === null)
        return forward(children[childFor(tenant ?? "", "", n)]!, req, url, undefined);
      if (Number(req.headers.get("content-length") ?? NaN) > maxBodyBytes) return fail(413, tooLarge);
      let body: Uint8Array;
      try {
        body = new Uint8Array(await req.arrayBuffer());
      } catch {
        return fail(400, "body could not be read");
      }
      return forward(children[childFor(tenant, userOf(body), n)]!, req, url, body);
    },
    // Nothing above should throw; if it does, the caller gets the server's 503, never Bun's default 500.
    error: () => fail(503, UNAVAILABLE),
  });

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? config.host,
    children,
    async stop() {
      void server.stop(true);
      await stopChildren();
    },
  };
}

/** `main.ts` with EDEN_PROCESSES above 1: starts the router, stops the children on SIGINT/SIGTERM. */
export async function runRouter(config: ServerConfig): Promise<void> {
  const started = performance.now();
  let router: Router;
  try {
    router = await startRouter({ config });
  } catch (e) {
    // A child's own message (a bad sources file, a bad variable) is already on stderr.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const stop = () => void router.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(
    `eden router listening on http://${router.hostname}:${router.port}${config.dev ? " (dev, no auth)" : ""}` +
      ` (startup ${Math.round(performance.now() - started)} ms; ${config.processes} processes, users pinned by` +
      ` tenant/user; per-tenant caps divided by ${config.processes})`,
  );
}
