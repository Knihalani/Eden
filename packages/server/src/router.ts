/**
 * The multi-process router (D113 stage 1, D163): one Bun.serve front and N child server processes (`main.ts` with
 * EDEN_ROUTER_CHILD="i/N"), started when EDEN_PROCESSES is above 1. Every piece of per-user state (cache, sessions,
 * budgets, reader and card caches, sync) lives in the one process that serves the user, so the engine's work spreads
 * over cores only if each user always reaches the same process: the router sends each request to child
 * `childFor(tenant, userId, N)`, a stable hash of the tenant (from the API key, as http.ts reads it) and the body's
 * `userId`. Sticky by construction: no table, nothing to keep or forget here.
 *
 * Changing N reshuffles users: most land on another child, where their in-memory state starts over (as after any
 * restart, D8) and the source-map rows the old child wrote are not read. Those rows hold per-user entity names, so
 * forget must still reach them: `/v1/forget` goes to every child (rare and cheap), each deleting the user's rows from
 * its own file, and answers with the owning child's answer, or 503 when any child could not forget. Files no current
 * child opens (`source-map.db` when N > 1, `source-map.<i>.db` for i >= N, or every `.<i>` file when N is 1) are
 * merged into the current set before any child starts (`rehomeSourceMaps`): each user's rows go to the file of the
 * child that now serves them and the stranded file is deleted, so no file is left that forget never reaches.
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
 * Every start, a restart included, has its own deadline (`startTimeoutMs`, D172): a child that has not reported its
 * port by then is killed (SIGKILL), so a start-up stall (a wedged gate worker, a slow file open) becomes one more
 * failed start, retried with the same backoff, instead of a child that holds 1/N of the users at 503 forever.
 * `/healthz` answers here: 200 while at least one child is up (`up` < `processes` in the body says the instance is
 * degraded: alert on that, but a load balancer must not pull every user for one child's 1/N), 503 when none is.
 *
 * The router reads each POST body once to find `userId` (a `JSON.parse` the child repeats; router.bench.ts measures
 * the hop) and forwards the bytes unchanged with the `authorization` and `content-type` headers. A declared
 * content-length past `maxBodyBytes` is refused here with the handler's 413 (D100) so it is never buffered twice,
 * and a request past the tenant's whole rate (`tenantRatePerSec`, `tenantBurst`, undivided) gets the handler's 429
 * here before its body is read; every other answer, auth, the child's own 1/N rate limit and validation included, is
 * the child's.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SourceMap } from "@eden/graph";
import { fnv1a, Gcra, mix32 } from "@eden/primitives";
import { bodyShapeUnder } from "@eden/protocol";
import { childSourceMapPath, DEFAULT_MAX_BODY_BYTES, MAX_PROCESSES, type ServerConfig } from "./config";

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
  // A body the child refuses unparsed (`bodyShapeUnder`, http.ts) is not parsed here either: padded structure is where
  // the parse's cost lies (hundreds of ms for 8 MB), on the one thread every tenant's requests pass through.
  if (body.byteLength === 0 || !bodyShapeUnder(body)) return "";
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

/**
 * Moves the source-map rows of files that no process of an N-process server opens into the files it does (D163), then
 * deletes the stranded files. Owned: `base` when N is 1, else `childSourceMapPath(base, i)` for i < N. Each user's
 * rows go to the file of `childFor(tenant, user, N)`: counts add up (`mention`, `utility`), a planner arm already in
 * the target wins. Run before any process opens the files (the router before its children, `main.ts` before
 * `buildPartner`). Returns the stranded files it merged. Throws, so the server does not start, when a stranded file
 * cannot be read or deleted: a file left behind would hold rows that `/v1/forget` never reaches.
 *
 * Not atomic across files: each target is one transaction that copies a user's rows and deletes them from the
 * stranded file, but SQLite in WAL mode commits each attached file on its own, so a crash between the two commits can
 * leave a row in both. The next start moves it again and its counts add twice (learning only, which shrugs it off);
 * no row is ever lost to forget, which reaches every current file and leaves no stranded one.
 */
export function rehomeSourceMaps(base: string, n: number, log: (line: string) => void = console.error): string[] {
  if (base === "" || base === ":memory:") return [];
  const owned = n <= 1 ? [base] : Array.from({ length: n }, (_, i) => childSourceMapPath(base, i));
  const candidates = [base, ...Array.from({ length: MAX_PROCESSES }, (_, i) => childSourceMapPath(base, i))];
  const stranded = candidates.filter((f) => !owned.includes(f) && existsSync(f));
  for (const file of stranded) {
    const src = new Database(file);
    let users = 0;
    try {
      src.exec("PRAGMA busy_timeout = 2000");
      const tables = new Set(
        (src.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      const present = TABLES.filter((t) => tables.has(t));
      const byOwner = new Map<number, string[]>();
      const scopes = new Set<string>();
      for (const t of present) {
        for (const { scope } of src.query(`SELECT DISTINCT scope FROM ${t}`).all() as { scope: string }[]) {
          scopes.add(scope);
        }
      }
      for (const scope of scopes) {
        // Scope keys are "tenant/user" (protocol's scopeKey); a tenant id never holds "/" (config.ts checks isId).
        const slash = scope.indexOf("/");
        const owner = slash < 0 ? 0 : childFor(scope.slice(0, slash), scope.slice(slash + 1), n);
        let list = byOwner.get(owner);
        if (!list) byOwner.set(owner, (list = []));
        list.push(scope);
      }
      users = scopes.size;
      for (const [owner, list] of byOwner) mergeInto(owned[owner]!, file, present, list);
    } finally {
      src.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    log(
      `eden: EDEN_PROCESSES is ${n}; moved the source-map rows of ${users} users from ${file}, which no process ` +
        `opens any more, into the current files and deleted it`,
    );
  }
  return stranded;
}

const TABLES = ["mention", "utility", "planner_arm"] as const;

/** One transaction on `target`: copy `scopes`' rows from the attached stranded file, then delete them there. */
function mergeInto(target: string, from: string, tables: readonly string[], scopes: string[]): void {
  // Creates the schema in a target no child has opened yet, exactly as the child will.
  new SourceMap(target).close();
  const db = new Database(target);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.query("ATTACH DATABASE ? AS stranded").run(from);
    db.transaction(() => {
      db.exec("CREATE TEMP TABLE moving (scope TEXT PRIMARY KEY)");
      const add = db.query("INSERT OR IGNORE INTO moving (scope) VALUES (?)");
      for (const scope of scopes) add.run(scope);
      const moving = "scope IN (SELECT scope FROM temp.moving)";
      if (tables.includes("mention")) {
        db.exec(`INSERT INTO main.mention (scope, entity, source_id, count, last_seen)
          SELECT scope, entity, source_id, count, last_seen FROM stranded.mention WHERE ${moving}
          ON CONFLICT (scope, entity, source_id) DO UPDATE SET count = count + excluded.count,
            last_seen = MAX(last_seen, excluded.last_seen)`);
      }
      if (tables.includes("utility")) {
        db.exec(`INSERT INTO main.utility (scope, situation, source_id, shown, used)
          SELECT scope, situation, source_id, shown, used FROM stranded.utility WHERE ${moving}
          ON CONFLICT (scope, situation, source_id) DO UPDATE SET shown = shown + excluded.shown,
            used = used + excluded.used`);
      }
      if (tables.includes("planner_arm")) {
        db.exec(`INSERT INTO main.planner_arm (scope, source_id, bucket, shape, alpha, beta)
          SELECT scope, source_id, bucket, shape, alpha, beta FROM stranded.planner_arm WHERE ${moving}
          ON CONFLICT (scope, source_id, bucket, shape) DO NOTHING`);
      }
      for (const t of tables) db.exec(`DELETE FROM stranded.${t} WHERE ${moving}`);
      db.exec("DROP TABLE temp.moving");
    })();
    db.exec("DETACH DATABASE stranded");
  } finally {
    db.close();
  }
}

const decoder = new TextDecoder();
const UNAVAILABLE = "temporarily unable to serve context";
const MAX_RESTART_MS = 30_000;

export interface RouterOptions {
  /** The router's own configuration (`loadConfig`): port, host, keys, dev, body cap, source-map base, processes. */
  config: Pick<ServerConfig, "port" | "host" | "keys" | "dev" | "sourceMapPath" | "processes"> &
    Partial<Pick<ServerConfig, "maxBodyBytes" | "tenantRatePerSec" | "tenantBurst">>;
  /** The environment each child starts from (default `process.env`); the router sets its own variables over it. */
  env?: Record<string, string | undefined>;
  /** The child entry (default `main.ts` beside this file). */
  entry?: string;
  /** Wait before an exited child is started again; default 1,000 ms, doubled while it keeps failing to start. */
  restartMs?: number;
  /**
   * How long each start of a child (the first and every restart) may take to report its port before it is killed;
   * default 30 s. A first start past it fails `startRouter`; a restart past it is retried with backoff (D172).
   */
  startTimeoutMs?: number;
  /** Receives each child's stdout (tests, the bench); unset, children write to the router's stdout. */
  onOutput?: (index: number, text: string) => void;
  /** Told each child's pid as it is spawned (tests check that a failed start leaves no child running). */
  onSpawn?: (index: number, pid: number) => void;
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
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
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

  // Each start resolves when the child reports its port, rejects if it exits first or misses its deadline (it is then
  // killed, and its exit takes the usual path: logged, and restarted with backoff unless the router is stopping).
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
      let timedOut = false;
      // Assigned just below, before any IPC message or exit can be delivered (both arrive on later ticks).
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const proc = Bun.spawn([process.execPath, entry], {
        env: childEnv,
        stdin: "ignore",
        stdout: options.onOutput ? "pipe" : "inherit",
        stderr: "inherit",
        ipc(message) {
          const port = (message as { edenListening?: unknown } | null)?.edenListening;
          if (ready || typeof port !== "number") return;
          ready = true;
          clearTimeout(deadline);
          c.port = port;
          c.up = true;
          c.restartMs = baseRestartMs;
          resolve();
        },
      });
      c.proc = proc;
      c.pid = proc.pid;
      deadline = setTimeout(() => {
        if (ready || c.proc !== proc) return;
        timedOut = true;
        log(
          `eden router: child ${c.index} (pid ${proc.pid}) did not report its port in ${startTimeoutMs} ms; ` +
            `killing it`,
        );
        proc.kill("SIGKILL");
      }, startTimeoutMs);
      options.onSpawn?.(c.index, proc.pid);
      if (options.onOutput && proc.stdout instanceof ReadableStream) void pipeOut(proc.stdout, c.index);
      void proc.exited.then((code) => {
        clearTimeout(deadline);
        if (c.proc !== proc) return;
        c.up = false;
        c.port = 0;
        c.proc = null;
        if (timedOut) reject(new Error(`eden router: child ${c.index} did not start in ${startTimeoutMs} ms`));
        else if (!ready) reject(new Error(`eden router: child ${c.index} exited with code ${code} before listening`));
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

  // Before any child opens its file: no row may sit in a file no child of this N reaches (forget would miss it).
  rehomeSourceMaps(config.sourceMapPath, n, log);

  // Each spawn carries its own deadline, so this settles within `startTimeoutMs` (plus the kill) either way. On a
  // failure the exit handler has already scheduled a restart; stopChildren sets `stopping` and clears that timer
  // before it can fire, then stops every child still starting or up, so a failed start leaves no process behind.
  try {
    await Promise.all(children.map(spawn));
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
  // The tenant's whole rate and burst (each child holds 1/N of them): past it, a request is refused here before its
  // body is read, as one process refuses it (http.ts). Otherwise a tenant over its rate still had every body buffered
  // and parsed on the router's one thread, unlimited, before a child could say 429, starving every other tenant.
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });

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

  // Forget goes to every child (D163): after N changed, a child other than the owner can still hold the user's
  // source-map rows. The caller gets the owner's answer (its 400 for a bad body, say); a 2xx there with any other
  // child down or failing is a 503, so the caller retries until every file is clean.
  const forgetEverywhere = async (owner: Child, req: Request, url: URL, body: Uint8Array): Promise<Response> => {
    const answers = await Promise.all(children.map((c) => forward(c, req, url, body)));
    const mine = answers[owner.index]!;
    for (const r of answers) if (r !== mine) void r.arrayBuffer().catch(() => {}); // Frees each connection.
    if (mine.status < 200 || mine.status >= 300) return mine;
    if (answers.some((r) => r.status < 200 || r.status >= 300)) return fail(503, UNAVAILABLE);
    return mine;
  };

  // The router's own port can be taken (EADDRINUSE) after every child started: stop them before failing, as for a
  // child that could not start, so a failed start leaves no process behind.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = serveRouter();
  } catch (e) {
    await stopChildren();
    throw e;
  }

  return {
    port: server.port ?? 0,
    hostname: server.hostname ?? config.host,
    children,
    async stop() {
      void server.stop(true);
      await stopChildren();
    },
  };

  function serveRouter() {
    return Bun.serve({
      port: config.port,
      hostname: config.host,
      // The same cap as each child's (D100): a chunked body past it is refused before it is buffered here.
      maxRequestBodySize: maxBodyBytes,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/healthz") {
          const up = children.filter((c) => c.up).length;
          if (up === n) return Response.json({ ok: true, processes: n, up });
          // Degraded, not down: 503 here would let a load balancer silence every user for one child's 1/N.
          const error = `${n - up} of ${n} processes down`;
          return Response.json({ ok: up > 0, processes: n, up, error }, { status: up > 0 ? 200 : 503 });
        }
        const tenant = tenantOf(req);
        // Only an authenticated POST is read for its user; anything else gets the child's own answer (405, 401).
        if (req.method !== "POST" || tenant === null)
          return forward(children[childFor(tenant ?? "", "", n)]!, req, url, undefined);
        const waitMs = limiter.take(tenant);
        if (waitMs > 0) {
          return Response.json(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) } },
          );
        }
        if (Number(req.headers.get("content-length") ?? NaN) > maxBodyBytes) return fail(413, tooLarge);
        let body: Uint8Array;
        try {
          body = new Uint8Array(await req.arrayBuffer());
        } catch {
          return fail(400, "body could not be read");
        }
        const owner = children[childFor(tenant, userOf(body), n)]!;
        if (url.pathname === "/v1/forget") return forgetEverywhere(owner, req, url, body);
        return forward(owner, req, url, body);
      },
      // Nothing above should throw; if it does, the caller gets the server's 503, never Bun's default 500.
      error: () => fail(503, UNAVAILABLE),
    });
  }
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
