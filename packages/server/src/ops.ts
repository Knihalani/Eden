/**
 * What an operator and a router need from one server process beyond the API (D992):
 *
 * - `GET /readyz`: 200 while the process takes traffic, 503 once it drains (SIGTERM), so a load balancer or the
 *   cluster router stops sending before it stops. `/healthz` (liveness) stays as it was.
 * - `GET /metrics`: Prometheus text: requests and their latency by route, users held (live, warm, frozen), the
 *   persistence store's counters, memory. Counts only, no tenant or user (D56's rule for traces applies).
 * - `POST /internal/cluster` (`EDEN_CLUSTER_KEY` as the bearer): the cluster router's membership, numbered by an
 *   epoch (an older one is ignored). Mode `release` (a planned change): every user the new membership gives another
 *   machine is written with their sync state and source-map rows, handed to the store and dropped here, and only then
 *   does the process take the new table. Mode `drop` (a failover, or a node re-admitted after one): the table first,
 *   then those users are dropped without writing anything, since another machine has served them since. With a table,
 *   the process fences itself (review of D992): an API request for a user another machine owns gets 503 "not the
 *   owner", and nothing of such a user is written to or deleted from the store.
 *
 * The router (router.ts) answers the same three for the whole machine: readiness of every child, the children's
 * metrics summed, and the cluster message sent to every child, their answers summed.
 */
import { timingSafeEqual } from "node:crypto";
import { FIRST_VALUE_LE, type ContextPartner, type SharedFrozenDisk } from "@eden/engine";
import { childTable, OwnerTable } from "@eden/primitives";
import { bucketOf, type Scope } from "@eden/protocol";
import { modelCache, modelFailures } from "./build";
import { pathOf } from "./http";

/** Routes timed by name; anything else is "other", so a scanner cannot grow the label set. */
const ROUTES = new Set([
  "/v1/events",
  "/v1/ask",
  "/v1/check",
  "/v1/pending",
  "/v1/feedback",
  "/v1/forget",
  "/v1/sources",
  "/v1/sources/changed",
  "/v1/sources/items",
  "/v1/sources/refs",
  "/v1/sources/removed",
  "/v1/usage",
  "/v1/whoami",
  "/v1/explain",
]);
/** Latency buckets (seconds): the fast path is milliseconds, a waited event up to `waitMs` (5 s). */
const LE = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface ClusterMessage {
  /** This machine's node id. */
  self: string;
  /** Every node of the new membership (ids). */
  nodes: string[];
  /** The router's membership number; a message older than the last one applied is ignored. */
  epoch?: number;
  /** `release` (default): write and hand over moved users; `drop`: discard them, another machine has newer state. */
  mode?: "release" | "drop";
  /**
   * How long the router waits for this node's answer (S1-P6): the node plans the release and its store writes
   * inside it — scaled by the router to the users this node is expected to move. Absent (an older router): the
   * node's own `releaseMs` floor applies, as before.
   */
  deadlineMs?: number;
}

/**
 * `Bun.serve`'s `error` handler for every server (R1): a throw past `Ops.wrap` is the 503 an integration treats as
 * silence, never Bun's default 500.
 */
export function serveError(): Response {
  return Response.json({ error: "temporarily unable to serve context" }, { status: 503 });
}

/** Routes that reach every node whoever owns the user (`/v1/forget` and `/v1/usage` fan out), never fenced. */
const FAN_OUT = new Set(["/v1/forget", "/v1/usage"]);
/**
 * The most distinct nodes a membership may name (R1): far above any cluster this serves, and far under placement's
 * own 32,767, whose table takes about 1 ms a node to build on the event loop. A larger membership is a 400.
 */
const MAX_NODES = 1_024;

export interface ClusterAnswer {
  released: number;
  written: number;
  pending: number;
  /** Users the node held when the message landed: the router's estimate base for this node's next move (S1-P6). */
  held: number;
  ms: number;
}

/** Whether `got` is the cluster key, in constant time. */
export function clusterKeyMatches(key: string | undefined, req: Request): boolean {
  if (!key) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Ops {
  draining = false;
  private readonly started = Date.now();
  private readonly counts = new Map<string, number>();
  private readonly hist = new Map<string, Float64Array>();
  private readonly requestNames = new Map<string, Map<number, string>>();
  /** The machine-level owner of each bucket, once a cluster router said (null: not in a cluster yet). */
  private table: OwnerTable | null = null;
  private self = "";
  private epoch = -1;
  private readonly kids: Uint8Array;

  constructor(
    private readonly partner: ContextPartner,
    private readonly disk: SharedFrozenDisk | { count: number } | null,
    private readonly opts: {
      clusterKey?: string;
      child: { index: number; count: number };
      releaseMs: number;
      /** The request's user, for the ownership fence: the tenant from its key, the body's `userId`. */
      userOf?: (req: Request) => Promise<{ tenantId: string; userId: string } | null>;
      /** Called for each released or dropped user (their connections close, as on a forget). */
      onReleased?: (scope: Scope) => void;
    },
  ) {
    this.kids = childTable(opts.child.count);
    if (disk && "setWritable" in disk) disk.setWritable((b) => this.machineOwns(b));
  }

  /** Whether this machine owns a bucket as last told; true outside a cluster (no table yet). */
  machineOwns(bucket: number): boolean {
    return this.table === null || this.table.owner(bucket) === this.self;
  }

  /**
   * Whether this process owns a bucket in the store's sweep: this child's, and this machine's as last told (outside a
   * cluster every bucket is the machine's, so a single machine with a store sweeps its own copies too).
   */
  ownsInStore = (bucket: number): boolean => this.kids[bucket] === this.opts.child.index && this.machineOwns(bucket);

  /** Wraps the API handler: answers the ops routes itself and times every other request. */
  wrap(handler: (req: Request) => Promise<Response> | Response): (req: Request) => Promise<Response> {
    const inner = this.serve(handler);
    // Never a 500 (R1): a throw anywhere below (the fence reading a body the client cut off, a handler bug) is the
    // 503 an integration treats as silence. Bun's default answer to a throw is a 500 with no body.
    return async (req) => {
      try {
        return await inner(req);
      } catch {
        return Response.json({ error: "temporarily unable to serve context" }, { status: 503 });
      }
    };
  }

  private serve(handler: (req: Request) => Promise<Response> | Response): (req: Request) => Promise<Response> {
    return async (req) => {
      const path = pathOf(req.url);
      if (req.method === "GET" && path === "/readyz") {
        // `held` (S1-P6): the cluster router's probe reads it to keep its per-node move estimate fresh between
        // memberships; a machine's router sums its children's.
        return this.draining
          ? Response.json({ ready: false, error: "draining" }, { status: 503 })
          : Response.json({ ready: true, held: this.partner.heldCount() });
      }
      if (req.method === "GET" && path === "/metrics") {
        return new Response(this.metrics(), { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      if (path === "/internal/cluster") {
        if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
        if (!clusterKeyMatches(this.opts.clusterKey, req)) {
          return Response.json({ error: "missing or wrong cluster key" }, { status: 401 });
        }
        let msg: ClusterMessage;
        try {
          msg = (await req.json()) as ClusterMessage;
        } catch {
          return Response.json({ error: "body must be JSON" }, { status: 400 });
        }
        if (
          typeof msg?.self !== "string" ||
          !Array.isArray(msg.nodes) ||
          !msg.nodes.every((n) => typeof n === "string") ||
          // Placement's own bound (`OwnerTable`): past it the table throws (R1).
          new Set(msg.nodes).size > MAX_NODES ||
          (msg.epoch !== undefined && !Number.isInteger(msg.epoch)) ||
          (msg.mode !== undefined && msg.mode !== "release" && msg.mode !== "drop")
        ) {
          return Response.json({ error: "body must be {self, nodes[], epoch?, mode?}" }, { status: 400 });
        }
        return Response.json(await this.cluster(msg));
      }
      // The fence: a user another machine owns is not served here (a request still in flight when this machine
      // released them, or a router that has not caught up), so this process never holds them again.
      if (this.table !== null && req.method === "POST" && !FAN_OUT.has(path) && this.opts.userOf) {
        const who = await this.opts.userOf(req.clone() as Request);
        if (who && !this.machineOwns(bucketOf(who.tenantId, who.userId))) {
          this.add("eden_cluster_fenced_total", 1);
          return Response.json(
            { error: "not the owner of this user here (rebalancing): retry" },
            {
              status: 503,
              headers: { "retry-after": "1" },
            },
          );
        }
      }
      const t0 = performance.now();
      const res = await handler(req);
      this.observe(ROUTES.has(path) ? path : "other", res.status, (performance.now() - t0) / 1_000);
      return res;
    };
  }

  /** Applies a membership (`/internal/cluster`): see the file's comment for the two modes. */
  async cluster(msg: ClusterMessage): Promise<ClusterAnswer> {
    const t0 = performance.now();
    const epoch = msg.epoch ?? this.epoch + 1;
    if (epoch < this.epoch) return { released: 0, written: 0, pending: 0, held: this.partner.heldCount(), ms: 0 };
    this.epoch = epoch;
    const held = this.partner.heldCount(); // at the message's landing: the router's base for its next estimate
    const table = new OwnerTable(msg.nodes);
    const moved = (s: Scope) => table.owner(bucketOf(s.tenantId, s.userId)) !== msg.self;
    const shared = this.disk && "handOff" in this.disk ? this.disk : null;
    if (msg.mode === "drop") {
      // Fenced first: nothing of these users is written or deleted from here on, then they go from memory and disk.
      this.table = table;
      this.self = msg.self;
      const { released } = this.partner.releaseMoved(moved, Number.POSITIVE_INFINITY, false);
      shared?.local.dropWhere((b) => table.owner(b) === msg.self);
      shared?.forgetAbsent();
      for (const s of released) this.opts.onReleased?.(s);
      this.add("eden_cluster_dropped_users_total", released.length);
      return {
        released: released.length,
        written: 0,
        pending: 0,
        held,
        ms: Math.round(performance.now() - t0),
      };
    }
    // Released under the old table, so their writes reach the store; the new table (and the fence) after. The
    // router's `deadlineMs` (scaled to the users it expects moved, S1-P6) may stretch the node's own bound —
    // the 2 s slack keeps room for the answer itself; the floor stays the node's releaseMs.
    const budget =
      msg.deadlineMs !== undefined ? Math.max(this.opts.releaseMs, msg.deadlineMs - 2_000) : this.opts.releaseMs;
    const { released, written } = this.partner.releaseMoved(moved, budget);
    let pending = 0;
    if (shared) {
      // Each released user's blob must be in the store before the router sends them to their new owner.
      const deadline = Promise.race([
        Promise.all(released.map((s) => shared.handOff(s))).then(() => 0),
        Bun.sleep(Math.max(0, budget - (performance.now() - t0))).then(() => 1),
      ]);
      if ((await deadline) === 1) pending = shared.backlog;
      shared.forgetAbsent();
    }
    // A newer membership landed while the hand-offs ran (R1): its table stands, not this older one.
    if (this.epoch === epoch) {
      this.table = table;
      this.self = msg.self;
    }
    for (const s of released) this.opts.onReleased?.(s);
    this.add("eden_cluster_released_users_total", released.length);
    return { released: released.length, written, pending, held, ms: Math.round(performance.now() - t0) };
  }

  observe(route: string, status: number, seconds: number): void {
    // The counter's name kept per route and status (both bounded), not built a request (D1892).
    let names = this.requestNames.get(route);
    if (!names) this.requestNames.set(route, (names = new Map()));
    let name = names.get(status);
    if (name === undefined) names.set(status, (name = `eden_requests_total{route="${route}",status="${status}"}`));
    this.add(name, 1);
    let h = this.hist.get(route);
    if (!h) this.hist.set(route, (h = new Float64Array(LE.length + 2)));
    for (let i = 0; i < LE.length; i++) if (seconds <= LE[i]!) h[i]!++;
    h[LE.length]! += seconds; // sum
    h[LE.length + 1]!++; // count
  }

  add(name: string, n: number): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }

  metrics(): string {
    const lines: string[] = [];
    const held = this.partner.held();
    const mem = process.memoryUsage();
    const gauge = (name: string, help: string, value: number) =>
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    gauge("eden_users_held", "Users held in memory, live or frozen", held.users);
    gauge("eden_users_frozen", "Users held frozen (warm and compact)", held.frozen);
    gauge("eden_users_warm", "Users held frozen warm (D862)", held.warm);
    gauge("eden_frozen_bytes", "Bytes of frozen users' blobs in memory", held.frozenBytes);
    gauge("eden_sessions", "Open agent sessions", held.sessions);
    gauge("eden_process_resident_bytes", "Resident memory of the server processes", mem.rss);
    gauge("eden_process_heap_bytes", "JavaScript heap in use", mem.heapUsed);
    gauge("eden_processes_ready", "Processes taking traffic (not draining)", this.draining ? 0 : 1);
    gauge("eden_uptime_seconds_max", "Seconds since the oldest process started", (Date.now() - this.started) / 1_000);
    const sync = this.partner.sync;
    if (sync) {
      // S1-P2 (B4): the backfill and fairness signals an autoscaler and the SLO alerts read. Counts only — a
      // tenant or a user is never a label (D56's rule for traces).
      const g = sync.gauges();
      gauge("eden_sync_users_backfilling", "Users with a source still in its first pass", g.backfilling);
      gauge("eden_sync_users_waiting_first_page", "Users with no source page stored yet", g.waitingFirstPage);
      gauge("eden_sync_kick_queue_users", "Users waiting for a kick turn", g.kickQueuedUsers);
      gauge("eden_sync_kick_queue_tenants", "Tenants with users waiting for a kick turn", g.kickQueuedTenants);
      gauge("eden_sync_kick_running", "Kicked backfill steps running", g.kickRunning);
      const st = sync.stats;
      for (let t = 0; t < 4; t++) {
        this.counts.set(`eden_sync_listing_calls_total{tier="${t}"}`, st.callsByTier[t] ?? 0);
        this.counts.set(`eden_sync_listing_held_total{tier="${t}"}`, st.heldByTier[t] ?? 0);
        this.counts.set(`eden_sync_listing_throttled_total{tier="${t}"}`, st.throttledByTier[t] ?? 0);
      }
      this.counts.set('eden_sync_listing_calls_total{tier="demand"}', st.demandCalls);
      this.counts.set('eden_sync_listing_throttled_total{tier="demand"}', st.demandThrottled);
    }
    if (this.disk) {
      gauge("eden_persisted_users", "Users with a blob in the local persistence directory", this.disk.count);
      if ("remote" in this.disk) {
        const r = this.disk.remote;
        gauge("eden_store_backlog", "Persistence store writes waiting or running", this.disk.backlog);
        for (const [k, v] of Object.entries(r)) {
          this.counts.set(`eden_store_${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_total`, v);
        }
      }
    }
    for (const [key, n] of Object.entries(modelFailures)) {
      const [role, kind] = key.split(":");
      this.counts.set(`eden_model_failures_total{kind="${kind}",role="${role}"}`, n);
    }
    // D1800: calls with a cache breakpoint against the cached tokens they read (docs/DEPLOY.md, "Prompt cache").
    for (const [role, c] of Object.entries(modelCache)) {
      this.counts.set(`eden_model_calls_total{role="${role}"}`, c.calls);
      this.counts.set(`eden_model_cache_breakpoint_calls_total{role="${role}"}`, c.breakpointCalls);
      this.counts.set(`eden_model_input_tokens_total{role="${role}"}`, c.inputTokens);
      this.counts.set(`eden_model_cache_read_tokens_total{role="${role}"}`, c.cacheReadTokens);
      this.counts.set(`eden_model_cache_write_tokens_total{role="${role}"}`, c.cacheWriteTokens);
    }
    let family = "";
    for (const [k, v] of [...this.counts].sort()) {
      const base = k.split("{")[0]!;
      if (base !== family) lines.push(`# TYPE ${(family = base)} counter`);
      lines.push(`${k} ${v}`);
    }
    lines.push("# TYPE eden_request_seconds histogram");
    for (const [route, h] of [...this.hist].sort()) {
      for (let i = 0; i < LE.length; i++)
        lines.push(`eden_request_seconds_bucket{route="${route}",le="${LE[i]}"} ${h[i]}`);
      lines.push(`eden_request_seconds_bucket{route="${route}",le="+Inf"} ${h[LE.length + 1]}`);
      lines.push(`eden_request_seconds_sum{route="${route}"} ${h[LE.length]}`);
      lines.push(`eden_request_seconds_count{route="${route}"} ${h[LE.length + 1]}`);
    }
    if (sync) {
      const st = sync.stats;
      lines.push("# TYPE eden_sync_first_value_seconds histogram");
      for (let i = 0; i < FIRST_VALUE_LE.length; i++) {
        lines.push(`eden_sync_first_value_seconds_bucket{le="${FIRST_VALUE_LE[i]}"} ${st.firstPageSeconds[i]}`);
      }
      lines.push(
        `eden_sync_first_value_seconds_bucket{le="+Inf"} ${st.firstPageCount}`,
        `eden_sync_first_value_seconds_sum ${st.firstPageSumSeconds}`,
        `eden_sync_first_value_seconds_count ${st.firstPageCount}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Prometheus texts of several processes summed into one (the router's `/metrics`): every sample with the same name
 * and labels is added (counts, gauges of users and bytes, histogram buckets alike), except `_max` gauges, which take
 * the largest. Comment lines are kept once, in first-seen order.
 */
export function sumMetrics(texts: string[]): string {
  const order: string[] = [];
  const values = new Map<string, number>();
  const seen = new Set<string>();
  for (const t of texts) {
    for (const line of t.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("#")) {
        if (!seen.has(line)) {
          seen.add(line);
          order.push(line);
        }
        continue;
      }
      const i = line.lastIndexOf(" ");
      const name = line.slice(0, i);
      const v = Number(line.slice(i + 1));
      if (!values.has(name)) order.push(name);
      const old = values.get(name);
      values.set(name, old === undefined ? v : /_max(\{|$)/.test(name) ? Math.max(old, v) : old + v);
    }
  }
  return `${order.map((k) => (k.startsWith("#") ? k : `${k} ${values.get(k)}`)).join("\n")}\n`;
}
