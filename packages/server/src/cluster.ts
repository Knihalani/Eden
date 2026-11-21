/**
 * The cluster router (D992): the tier above the machines, as router.ts is the tier above a machine's processes. It
 * holds no user state. Each request goes to the machine that owns its user's bucket (`bucketOf`) under rendezvous
 * hashing over the live nodes (`OwnerTable`), so:
 *
 * - **Adding a node** moves about 1/(n+1) of users, all to it. Before routing them there, the router sends the new
 *   membership to every live node (`POST /internal/cluster`); each releases the users it no longer owns (written with
 *   their sync state and source-map rows, D992, and in the store before it answers), and only then does the router
 *   switch. Requests for a moving user meanwhile get 503 with Retry-After (what an integration treats as silence).
 * - **Removing a node** (it leaves the list) is the same in reverse: it releases everything, its users spread over the
 *   others, each to their second choice.
 * - **A node that stops answering** (`/readyz` failed `failAfter` times in a row) is dropped at once: nothing can be
 *   released, so its users' new owners fetch their last stored blob (the compact freeze at 30 minutes idle, or the
 *   last shutdown or release) and poll their sources for what changed since. When it answers again (`recoverAfter`
 *   times), its users move back to it the planned way.
 *
 * Every per-tenant cap is held whole here: the tenant's rate and burst are enforced before a body is read, as the
 * machine router does; each machine's children keep their 1/N share as a backstop (D163), and the model spend cap is
 * divided by children and machines (`EDEN_CLUSTER_SIZE`, D992). `/v1/forget` goes to every node (503 unless all
 * answered: the caller retries until every copy is gone); `/v1/usage` is summed over nodes.
 *
 *   EDEN_NODES        "a=http://10.0.0.11:8790,b=http://10.0.0.12:8790" (id=url, ids stable: re-addressing a machine
 *                     moves nobody), or EDEN_NODES_FILE, a file of the same text (one per line or comma-separated),
 *                     re-read on SIGHUP and when it changes. A row may name its cell as a second token
 *                     (`a=http://… cell-a`, S1-P8); a cell'd list needs EDEN_CELL to say which the router serves.
 *   EDEN_CELL         the cell this router serves, when the nodes list names cells (S1-P8): membership, placement
 *                     and the published membership doc are then scoped to that cell's rows.
 *   EDEN_CLUSTER_KEY  the shared secret of the membership messages (24+ characters), the same on every node.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { type BlobStore, ShardedBlobStore } from "@eden/engine";
import { Gcra, OwnerTable, BUCKETS } from "@eden/primitives";
import { bucketOf, keylessOriginAllowed } from "@eden/protocol";
import { keyOf } from "./auth";
import { S3BlobStore, storeConfig } from "./blob-store";
import { DEFAULT_MAX_BODY_BYTES, type ServerConfig } from "./config";
import { sumMetrics } from "./ops";
import { sumUsage, userOf } from "./router";

export interface NodeSpec {
  id: string;
  url: string;
  /** The node's cell (S1-P8), when the list names cells: the second token of `id=url cell`. */
  cell?: string;
}

/**
 * Parses "id=url" entries, comma- or newline-separated; blank lines and # comments are skipped. An entry may name
 * its cell as a second token (`a=http://h:1 cell-a`, S1-P8): every entry must then name one — a list part-cell'd
 * would scope some nodes everywhere. With `cell` the rows of that cell are answered; without it every row, unless
 * the list names cells at all — then the caller must say which it routes for, or one router would merge cells back
 * into one membership. Cells name as ids do (`[A-Za-z0-9._-]`).
 */
export function parseNodes(text: string, cell?: string): NodeSpec[] {
  let out: NodeSpec[] = [];
  const ids = new Set<string>();
  let cellRows = 0;
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.replace(/#.*/, "").trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    const rest = eq < 0 ? "" : entry.slice(eq + 1).trim();
    const space = rest.search(/\s/);
    const url = (space < 0 ? rest : rest.slice(0, space)).replace(/\/+$/, "");
    const rowCell = space < 0 ? "" : rest.slice(space).trim();
    const id = eq < 0 ? "" : entry.slice(0, eq).trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`EDEN_NODES: "${entry}" must be id=url, id [A-Za-z0-9._-]`);
    if (!/^https?:\/\/[^\s/]+$/.test(url)) throw new Error(`EDEN_NODES: node ${id}'s url must be http(s)://host:port`);
    if (rowCell !== "" && !/^[A-Za-z0-9._-]{1,64}$/.test(rowCell))
      throw new Error(`EDEN_NODES: node ${id}'s cell must be [A-Za-z0-9._-]`);
    if (ids.has(id)) throw new Error(`EDEN_NODES: node ${id} is listed twice`);
    ids.add(id);
    if (rowCell !== "") cellRows++;
    out.push({ id, url, ...(rowCell === "" ? {} : { cell: rowCell }) });
  }
  if (cellRows > 0 && cellRows < out.length) throw new Error("EDEN_NODES: a cell on one row must be on every row");
  if (cell === undefined && cellRows > 0)
    throw new Error(
      `EDEN_NODES names cells (${[...new Set(out.map((n) => n.cell!))].join(", ")}): set EDEN_CELL to the one this router serves`,
    );
  if (cell !== undefined) out = out.filter((n) => n.cell === cell);
  return out;
}

/** A row of the fleet's top table (S1-P8): the user buckets `lo..hi` (inclusive) the cell at `url` serves. */
export interface TopRange {
  lo: number;
  hi: number;
  url: string;
}

/**
 * Parses the fleet's top table (S1-P8): `lo-hi=url` entries, comma- or newline-separated, blank lines and
 * `#` comments skipped. `lo`/`hi` are inclusive bucket bounds inside `0..BUCKETS-1`; `url` is the cell's load
 * balancer (in front of that cell's routers). The ranges must cover every bucket exactly once — a gap would
 * blackhole its users' requests, an overlap could route one user to either of two cells. A one-cell fleet is
 * one `0-65535` row. Nothing in the table changes at runtime: a range move lands users on the new cell through
 * the store, as membership moves them between nodes.
 */
export function parseTopTable(text: string): TopRange[] {
  const seen = new Uint8Array(BUCKETS);
  const out: TopRange[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const entry = raw.replace(/#.*/, "").trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    const range = eq < 0 ? "" : entry.slice(0, eq).trim();
    const url = (eq < 0 ? "" : entry.slice(eq + 1).trim()).replace(/\/+$/, "");
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) throw new Error(`EDEN_TOP_TABLE: "${entry}" must be lo-hi=url, e.g. 0-32767=https://cell-a`);
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > hi || hi >= BUCKETS) throw new Error(`EDEN_TOP_TABLE: "${entry}"'s range must be inside 0-${BUCKETS - 1}`);
    if (!/^https?:\/\/[^\s/]+$/.test(url))
      throw new Error(`EDEN_TOP_TABLE: range ${range}'s url must be http(s)://host:port`);
    for (let b = lo; b <= hi; b++) {
      if (seen[b]) throw new Error(`EDEN_TOP_TABLE: bucket ${b} is named by two rows`);
      seen[b] = 1;
    }
    out.push({ lo, hi, url });
  }
  if (out.length === 0) throw new Error("EDEN_TOP_TABLE lists no range");
  for (let b = 0; b < BUCKETS; b++)
    if (!seen[b]) throw new Error(`EDEN_TOP_TABLE: bucket ${b} is in no row (0-${BUCKETS - 1} must all be covered)`);
  return out;
}

/** The top table from EDEN_TOP_TABLE or EDEN_TOP_TABLE_FILE, or null when neither is set (not an edge). */
export function topTableFromEnv(env: NodeJS.ProcessEnv): { ranges: TopRange[]; file: string | null } | null {
  const file = env.EDEN_TOP_TABLE_FILE ?? "";
  const text = env.EDEN_TOP_TABLE ?? "";
  if (file === "" && text === "") return null;
  if (file !== "" && text !== "") throw new Error("set EDEN_TOP_TABLE or EDEN_TOP_TABLE_FILE, not both");
  return { ranges: parseTopTable(file !== "" ? readFileSync(file, "utf8") : text), file: file === "" ? null : file };
}

/** The nodes from EDEN_NODES or EDEN_NODES_FILE, or null when neither is set (not a cluster router). */
export function nodesFromEnv(
  env: NodeJS.ProcessEnv,
): { nodes: NodeSpec[]; file: string | null; cell: string | null } | null {
  const file = env.EDEN_NODES_FILE ?? "";
  const text = env.EDEN_NODES ?? "";
  if (file === "" && text === "") return null;
  if (file !== "" && text !== "") throw new Error("set EDEN_NODES or EDEN_NODES_FILE, not both");
  const cell = env.EDEN_CELL ?? "";
  if (cell !== "" && !/^[A-Za-z0-9._-]{1,64}$/.test(cell)) throw new Error("EDEN_CELL must be [A-Za-z0-9._-]");
  const nodes = parseNodes(file !== "" ? readFileSync(file, "utf8") : text, cell === "" ? undefined : cell);
  if (nodes.length === 0)
    throw new Error(cell === "" ? "EDEN_NODES lists no node" : `EDEN_NODES lists no node in cell ${cell}`);
  return { nodes, file: file === "" ? null : file, cell: cell === "" ? null : cell };
}

interface NodeState extends NodeSpec {
  up: boolean;
  fails: number;
  oks: number;
  /** Listed in the current membership (a node removed from the list is still released before it is left). */
  member: boolean;
  /** Stopping (its /readyz says "draining"): told to release, then left out. */
  draining: boolean;
  /** Taken out unplanned (or silent at a release): told to drop everything before it is admitted again. */
  reset: boolean;
}

export interface Rebalance {
  reason: string;
  /** Buckets that changed owner, and their share of all buckets. */
  moved: number;
  share: number;
  /** Users the nodes released (written and handed to the store), summed. */
  released: number;
  ms: number;
  /** Nodes that did not answer the membership message. */
  unanswered: string[];
}

export interface ClusterRouter {
  readonly port: number;
  readonly nodes: readonly NodeState[];
  /** The owner of a bucket now (tests, the bench). */
  owner(bucket: number): string | null;
  /** Replaces the node list (a resize): a planned rebalance. Resolves once routing has switched. */
  setNodes(nodes: NodeSpec[]): Promise<Rebalance | null>;
  /** Runs one health round now (tests); resolves with any rebalance it caused. */
  checkHealth(): Promise<Rebalance | null>;
  readonly rebalances: Rebalance[];
  stop(): Promise<void>;
}

export interface ClusterOptions {
  config: Pick<ServerConfig, "port" | "host" | "keys" | "dev"> &
    Partial<
      Pick<
        ServerConfig,
        "maxBodyBytes" | "tenantRatePerSec" | "tenantBurst" | "cluster" | "shutdownGraceMs" | "drainDelayMs"
      >
    >;
  nodes: NodeSpec[];
  /** Health probe interval; default 2 s (0: no timer, tests call `checkHealth`). */
  healthEveryMs?: number;
  /** Failed probes in a row before a node is dropped (default 3) and good ones before it is back (default 2). */
  failAfter?: number;
  recoverAfter?: number;
  /** How long nodes may take to release moved users before the router switches anyway; default 60 s. */
  rebalanceMs?: number;
  /**
   * Added to `rebalanceMs` per user a node is expected to move (the buckets it loses x its held per bucket,
   * S1-P6): a big move gets a longer bound instead of the node falling silent and being taken out. Default
   * 15 ms a user (a warm freeze ~9 ms, plus store-write room).
   */
  releasePerUserMs?: number;
  /** How long a request is retried while its node refuses connections (a restart); default 5 s. */
  retryRefusedMs?: number;
  /**
   * How long a forwarded request may take before the router answers 503 (default 60 s, R1): a node that accepts
   * connections and hangs must not hold the router's requests open for ever. Well above an event's 5 s wait.
   */
  forwardTimeoutMs?: number;
  /**
   * The shared store and key the leader publishes its membership to (S1-P7): the same EDEN_PERSIST_STORE the
   * nodes write frozen users to. A leader without it runs alone, as before.
   */
  membership?: { store: BlobStore; key: string };
  /**
   * Follow the published membership instead of leading (S1-P7, EDEN_CLUSTER_FOLLOW): no probes, no membership
   * messages, no rebalances — a stateless forwarder of the leader's placement, so several routers can sit behind
   * the LB. `everyMs`: the store poll (default 1 s).
   */
  follow?: { everyMs?: number };
  /**
   * The cell this router serves (S1-P8, EDEN_CELL): its `eden_cluster_*` metrics carry `cell="…"` so a per-cell
   * SLO alert reads one cell's series and no other cell's.
   */
  cell?: string;
  log?: (line: string) => void;
}

/** The published membership (S1-P7): byte for byte what a follower makes its own state. */
interface MembershipDoc {
  epoch: number;
  /** Nodes up and serving; placement is over these. */
  live: string[];
  /** Every member: the fan-out list for /v1/forget and /v1/usage. */
  all: string[];
  /**
   * The members' specs (id + url): the leader's list is the one truth — a follower never needs a nodes file of
   * its own to reach a node the leader added.
   */
  specs: NodeSpec[];
  /** Buckets mid-move: a request for one gets the 503 retry, as on the leader. */
  moved: number[];
  at: number;
  /** HMAC-SHA256 of the rest of the doc under EDEN_CLUSTER_KEY — a follower forwards tenant keys to these urls. */
  sig: string;
}

const UNAVAILABLE = "temporarily unable to serve context";
/** The rebalance log kept for callers (`rebalances`); the counter `rebalanceTotal` never trims. */
const MAX_REBALANCES = 100;

export async function startCluster(options: ClusterOptions): Promise<ClusterRouter> {
  const { config } = options;
  const log = options.log ?? console.error;
  const failAfter = options.failAfter ?? 3;
  const recoverAfter = options.recoverAfter ?? 2;
  const rebalanceMs = options.rebalanceMs ?? 60_000;
  const releasePerUserMs = options.releasePerUserMs ?? 15;
  /** Users each node last reported holding — on every probe and every membership answer (S1-P6). */
  const heldBy = new Map<string, number>();
  const retryRefusedMs = options.retryRefusedMs ?? 5_000;
  const forwardTimeoutMs = options.forwardTimeoutMs ?? 60_000;
  const grace = config.shutdownGraceMs ?? 10_000;
  const clusterKey = config.cluster?.key ?? "";
  if (clusterKey === "") throw new Error("a cluster router needs EDEN_CLUSTER_KEY (the same on every node)");
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });
  const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
    Response.json({ error }, { status, headers });

  let nodes: NodeState[] = options.nodes.map((n) => ({
    ...n,
    up: false,
    fails: 0,
    oks: 0,
    member: true,
    draining: false,
    reset: false,
  }));
  let table = new OwnerTable([]);
  const moving = new Uint8Array(BUCKETS);
  const rebalances: Rebalance[] = [];
  let rebalanceTotal = 0;
  const counts = new Map<string, number>();
  const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  let draining = false;
  // Everything that mutates membership — a health round, a resize's probe-and-admit, a rebalance — runs one at a
  // time, in order: an interval's next checkHealth otherwise probes and counts while a round still in flight (its
  // `reset` may wait a whole `rebalanceMs`) increments fails/oks beside it and drops or readmits nodes too early.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  /** The health round in flight (or queued on `chain`): interval callers share it rather than stack rounds. */
  let checking: Promise<Rebalance | null> | null = null;

  /** One `/readyz` probe: up, draining (a stop in progress: a planned leave), or down. */
  const probe = async (n: NodeState): Promise<"up" | "draining" | "down"> => {
    try {
      const r = await fetch(`${n.url}/readyz?all=1`, { signal: AbortSignal.timeout(1_500) });
      if (r.ok) {
        // The machine's held count rides its ready answer (S1-P6): the next resize's estimate is fresh, not the
        // count at the last membership — users accrue between them.
        const body = (await r.json().catch(() => null)) as { held?: number } | null;
        if (typeof body?.held === "number") heldBy.set(n.id, body.held);
        return "up";
      }
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      return body?.error === "draining" ? "draining" : "down";
    } catch {
      return "down";
    }
  };

  // Membership numbers: wall-clock based, so a restarted router's first message is newer than its predecessor's.
  let epoch = 0;
  const nextEpoch = () => (epoch = Math.max(Date.now(), epoch + 1));

  /** The membership message to one node; its answer, or null. */
  const tell = async (
    n: NodeState,
    ids: string[],
    mode: "release" | "drop",
    e: number,
    timeoutMs = rebalanceMs,
  ): Promise<{ released: number; pending: number; held?: number } | null> => {
    try {
      const r = await fetch(`${n.url}/internal/cluster`, {
        method: "POST",
        headers: { authorization: `Bearer ${clusterKey}`, "content-type": "application/json" },
        body: JSON.stringify({ self: n.id, nodes: ids, epoch: e, mode, deadlineMs: timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        void r.arrayBuffer().catch(() => {});
        return null;
      }
      const a = (await r.json()) as { released: number; pending: number; held?: number };
      if (a.held !== undefined) heldBy.set(n.id, a.held);
      return a;
    } catch {
      return null;
    }
  };

  /**
   * Moves routing to the owners the live members give. `release` (a planned change: a node added, removed, back or
   * draining): every live node, and a draining one, is told the new membership first and hands over what it no longer
   * owns; buckets that change owner answer 503 until it is done. `drop` (a node stopped answering): the others are
   * told, and the lost node too as far as it can be reached, to discard what they no longer own without writing it
   * (another machine now serves those users from the store). A node that does not answer a release is not trusted
   * with its old users: it is taken out and must be reset before it is admitted again (review of D992).
   */
  const rebalance = (reason: string, mode: "release" | "drop" = "release"): Promise<Rebalance | null> =>
    serialize(() => doRebalance(reason, mode));

  /** The rebalance itself; already-serialized callers (a health round, `setNodes`)
      run it inside their own `chain` turn. */
  const doRebalance = async (reason: string, mode: "release" | "drop" = "release"): Promise<Rebalance | null> => {
    const ids = nodes.filter((n) => n.member && n.up).map((n) => n.id);
    const next = new OwnerTable(ids);
    const movedBuckets = table.moved(next);
    // Every node that can hear it: the live ones, a draining one (it still holds users), and for a drop the lost one.
    const told = nodes.filter((n) => n.up || n.draining || (mode === "drop" && n.reset));
    if (movedBuckets.length === 0 && told.every((n) => n.member && n.up)) {
      table = next;
      return null;
    }
    const t0 = performance.now();
    const e = nextEpoch();
    for (const b of movedBuckets) moving[b] = 1;
    // S1-P6: each node's bound scales to the users it is expected to move — the buckets leaving it (the old
    // table still stands here) times the users it reported per bucket — so a big move gets a longer bound
    // instead of the node falling silent mid-write and being taken out as reset.
    const ownedBy = new Map<string, number>();
    const leaving = new Map<string, number>();
    for (let b = 0; b < BUCKETS; b++) {
      const o = table.owner(b);
      if (o !== null) ownedBy.set(o, (ownedBy.get(o) ?? 0) + 1);
    }
    for (const b of movedBuckets) {
      const o = table.owner(b)!;
      leaving.set(o, (leaving.get(o) ?? 0) + 1);
    }
    const deadlineFor = (n: NodeState) => {
      const owned = ownedBy.get(n.id) ?? 0;
      if (owned === 0) return rebalanceMs;
      const est = ((leaving.get(n.id) ?? 0) / owned) * (heldBy.get(n.id) ?? 0);
      return rebalanceMs + Math.round(est * releasePerUserMs);
    };
    publish(movedBuckets);
    const answers = await Promise.all(
      told.map((n) => tell(n, ids, mode, e, n.up || n.draining ? deadlineFor(n) : 2_000)),
    );
    const silent = told.filter((n, i) => answers[i] === null && n.up && mode === "release");
    for (const n of silent) {
      n.up = false;
      n.reset = true;
      n.oks = 0;
    }
    if (silent.length > 0) {
      // Routing excludes them now; the next round re-places their buckets the drop way.
      void Promise.resolve().then(() => rebalance(`no answer from ${silent.map((n) => n.id).join(", ")}`, "drop"));
    }
    table = next;
    for (const b of movedBuckets) moving[b] = 0;
    publish([]);
    for (const n of told) if (n.draining && answers[told.indexOf(n)] !== null) n.draining = false;
    nodes = nodes.filter((n) => n.member || n.up || n.draining);
    const r: Rebalance = {
      reason,
      moved: movedBuckets.length,
      share: movedBuckets.length / BUCKETS,
      released: answers.reduce((s, a) => s + (a?.released ?? 0), 0),
      ms: Math.round(performance.now() - t0),
      unanswered: told.filter((_, i) => answers[i] === null).map((n) => n.id),
    };
    // The log a reader inspects, bounded: the metric counts on `rebalanceTotal` so the trim costs nothing.
    rebalances.push(r);
    rebalanceTotal++;
    if (rebalances.length > MAX_REBALANCES) rebalances.splice(0, rebalances.length - MAX_REBALANCES);
    const pending = answers.reduce((s, a) => s + (a?.pending ?? 0), 0);
    log(
      `eden cluster: ${reason}: ${r.moved} of ${BUCKETS} buckets moved (${(r.share * 100).toFixed(1)}%), ` +
        `${r.released} users ${mode === "drop" ? "dropped" : "released"} in ${r.ms} ms; nodes ` +
        `${ids.join(", ") || "none"}` +
        (r.unanswered.length > 0 ? `; no answer from ${r.unanswered.join(", ")}` : "") +
        (pending > 0 ? `; ${pending} store writes still pending (those users may start from an older copy)` : ""),
    );
    return r;
  };

  /**
   * Re-admits a node that was taken out (it stopped answering, or did not answer a release): first it is told a
   * membership without itself, in drop mode, so whatever it still holds from before (older than what others served
   * since) is discarded; then it joins. False when it cannot be reset (it stays out).
   */
  const reset = async (n: NodeState): Promise<boolean> => {
    if (!n.reset) return true;
    const ids = nodes.filter((m) => m.member && m.up).map((m) => m.id);
    const ok = (await tell(n, ids, "drop", nextEpoch())) !== null;
    if (ok) n.reset = false;
    return ok;
  };

  const checkHealth = (): Promise<Rebalance | null> =>
    (checking ??= serialize(checkHealthRound).finally(() => {
      checking = null;
    }));

  const checkHealthRound = async (): Promise<Rebalance | null> => {
    const results = await Promise.all(nodes.map(probe));
    let changed = "";
    let mode: "release" | "drop" = "release";
    for (const [i, n] of nodes.entries()) {
      const state = results[i]!;
      if (state === "up") {
        n.fails = 0;
        n.oks++;
        if (!n.up && !n.draining && n.member && n.oks >= recoverAfter && (await reset(n))) {
          n.up = true;
          changed ||= `node ${n.id} is back`;
        }
      } else if (state === "draining" && n.up) {
        // A stop in progress: a planned leave, its users handed over while it still serves (D994's drain delay).
        n.up = false;
        n.draining = true;
        n.reset = true;
        n.oks = 0;
        changed ||= `node ${n.id} is draining`;
      } else {
        n.oks = 0;
        n.fails++;
        if (n.up && n.fails >= failAfter) {
          n.up = false;
          n.reset = true;
          changed ||= `node ${n.id} stopped answering`;
          mode = "drop";
        }
      }
    }
    return changed ? doRebalance(changed, mode) : null;
  };

  /**
   * Writes the current membership for followers to adopt (S1-P7); failures log, never break the rebalance.
   * Each publication takes its own epoch (the move's staging and its completion must both adopt) and is signed:
   * a follower forwards tenant credentials to the urls it reads here, so an unsigned doc is refused.
   */
  const publish = (moved: number[]) => {
    const m = options.membership;
    if (!m || options.follow) return;
    const body = {
      epoch: nextEpoch(),
      live: nodes.filter((n) => n.member && n.up).map((n) => n.id),
      all: nodes.filter((n) => n.member).map((n) => n.id),
      specs: nodes.filter((n) => n.member).map((n) => ({ id: n.id, url: n.url })),
      moved,
      at: Date.now(),
    };
    const doc: MembershipDoc = {
      ...body,
      sig: createHmac("sha256", clusterKey).update(JSON.stringify(body)).digest("hex"),
    };
    void m.store
      .put(m.key, new TextEncoder().encode(JSON.stringify(doc)))
      .catch((err) =>
        log(`eden cluster: membership not published: ${err instanceof Error ? err.message : String(err)}`),
      );
  };

  /** A follower makes the published membership its own, on a newer epoch only (S1-P7). */
  const poll = async () => {
    const m = options.membership;
    if (!m || !options.follow) return;
    const raw = await m.store.get(m.key).catch(() => null);
    if (raw === null) return;
    let doc: MembershipDoc;
    try {
      doc = JSON.parse(new TextDecoder().decode(raw)) as MembershipDoc;
    } catch {
      return; // A torn or malformed doc: the last good one stands.
    }
    if (typeof doc.epoch !== "number" || doc.epoch <= epoch || !Array.isArray(doc.live) || !Array.isArray(doc.all))
      return;
    // Only a doc signed with the cluster key may move the table: write access to the store alone must not hand
    // a follower urls to forward tenant credentials to.
    const { sig, ...body } = doc;
    const want = Buffer.from(createHmac("sha256", clusterKey).update(JSON.stringify(body)).digest("hex"), "utf8");
    const have = typeof sig === "string" ? Buffer.from(sig, "utf8") : Buffer.alloc(0);
    // Byte lengths first: a sig long enough in characters but not in bytes must not throw inside timingSafeEqual.
    if (have.length !== want.length || !timingSafeEqual(have, want)) return;
    epoch = doc.epoch;
    const liveSet = new Set(doc.live);
    const allSet = new Set(doc.all);
    // The published specs are the truth: a node the leader added that this router's list never held is adopted
    // with its url; a listed one's url is refreshed.
    for (const s of doc.specs ?? []) {
      const known = nodes.find((n) => n.id === s.id);
      if (known) known.url = s.url;
      else nodes.push({ ...s, up: false, fails: 0, oks: 0, member: false, draining: false, reset: false });
    }
    for (const n of nodes) {
      n.member = allSet.has(n.id);
      n.up = liveSet.has(n.id);
    }
    table = new OwnerTable(doc.live);
    moving.fill(0);
    for (const b of doc.moved ?? []) if (Number.isInteger(b) && b >= 0 && b < BUCKETS) moving[b] = 1;
  };

  // First membership: every node that answers now (one probe each, no waiting for `recoverAfter`). A follower
  // runs none of this — it only polls the store for the leader's published membership (S1-P7).
  let timer: ReturnType<typeof setInterval> | null = null;
  if (options.follow) {
    await poll();
    if (epoch <= 0) log("eden cluster: no membership published yet; serving 503 until the leader writes one");
    timer = setInterval(() => void poll(), options.follow.everyMs ?? 1_000);
  } else {
    const first = await Promise.all(nodes.map(probe));
    nodes.forEach((n, i) => (n.up = first[i] === "up"));
    if (!nodes.some((n) => n.up)) log("eden cluster: no node answers /readyz yet; serving 503 until one does");
    await rebalance("start");

    timer =
      (options.healthEveryMs ?? 2_000) > 0
        ? setInterval(() => void checkHealth(), options.healthEveryMs ?? 2_000)
        : null;
  }

  const tenantOf = (req: Request): string | null => {
    const key = keyOf(req);
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    return config.dev && !key ? "dev" : null;
  };

  const forward = async (n: NodeState | undefined, req: Request, url: URL, body?: Uint8Array) => {
    if (!n || !n.up) return fail(503, UNAVAILABLE);
    const headers: Record<string, string> = {};
    const auth = req.headers.get("authorization");
    if (auth !== null) headers.authorization = auth;
    const type = req.headers.get("content-type");
    if (type !== null) headers["content-type"] = type;
    // A refused connection is a node restarting (an upgrade: about a second) before the probes notice: the request
    // never reached it, so it is retried for up to `retryRefusedMs`. Any other failure (a reset after the node took
    // the request) is not retried: an event must not be observed twice.
    const until = performance.now() + retryRefusedMs;
    for (;;) {
      try {
        return await fetch(`${n.url}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          signal: AbortSignal.timeout(forwardTimeoutMs),
        });
      } catch (e) {
        const code = (e as { code?: string } | null)?.code ?? "";
        if (!/ECONNREFUSED|ConnectionRefused/i.test(code) || performance.now() > until || !n.up) {
          return fail(503, UNAVAILABLE);
        }
        count("retried_refused");
        await Bun.sleep(200);
      }
    }
  };
  const nodeOf = (id: string | null) => nodes.find((n) => n.id === id);
  const live = () => nodes.filter((n) => n.up);

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: maxBodyBytes,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        const up = live().length;
        return Response.json({ ok: up > 0, nodes: nodes.length, up }, { status: up > 0 ? 200 : 503 });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const up = live().length;
        if (!draining && up > 0) return Response.json({ ready: true, nodes: nodes.length, up });
        return Response.json({ ready: false, error: draining ? "draining" : "no node up" }, { status: 503 });
      }
      if (req.method === "GET" && url.pathname === "/metrics") return metrics();
      if (url.pathname.startsWith("/internal/")) return fail(404, "not found");
      const tenant = tenantOf(req);
      if (req.method !== "POST" || tenant === null) return forward(live()[0], req, url);
      if (tenant === "dev" && !keyOf(req) && !keylessOriginAllowed(req.headers.get("origin")))
        return fail(403, "dev mode serves no key-less request from another site's page");
      const waitMs = limiter.take(tenant);
      if (waitMs > 0) {
        count("rate_limited");
        return fail(429, "rate limited", { "retry-after": String(Math.ceil(waitMs / 1_000)) });
      }
      if (Number(req.headers.get("content-length") ?? NaN) > maxBodyBytes) {
        return fail(413, `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`);
      }
      let body: Uint8Array;
      try {
        body = new Uint8Array(await req.arrayBuffer());
      } catch {
        return fail(400, "body could not be read");
      }
      const bucket = bucketOf(tenant, userOf(body));
      if (url.pathname === "/v1/forget") return everywhere(req, url, body, table.owner(bucket), "forget");
      if (url.pathname === "/v1/usage") return everywhere(req, url, body, table.owner(bucket), "usage");
      if (moving[bucket]) {
        count("rebalancing");
        return fail(503, "rebalancing: retry shortly", { "retry-after": "1" });
      }
      count("forwarded");
      return forward(nodeOf(table.owner(bucket)), req, url, body);
    },
    error: () => fail(503, UNAVAILABLE),
  });

  /** Forget (every node must answer 2xx) and usage (summed) go to every node; the owner's 4xx is the caller's. */
  async function everywhere(req: Request, url: URL, body: Uint8Array, owner: string | null, kind: "forget" | "usage") {
    const all = nodes.filter((n) => n.member);
    const answers = await Promise.all(all.map((n) => forward(n, req, url, body)));
    const mineAt = all.findIndex((n) => n.id === owner);
    const mine = answers[mineAt] ?? answers[0];
    if (mine && mine.status >= 400 && mine.status < 500) {
      for (const r of answers) if (r !== mine) void r.arrayBuffer().catch(() => {});
      return mine;
    }
    if (kind === "forget") {
      for (const r of answers) if (r !== mine) void r.arrayBuffer().catch(() => {});
      if (!mine || answers.some((r) => r.status < 200 || r.status >= 300)) return fail(503, UNAVAILABLE);
      return mine;
    }
    const parts: Record<string, unknown>[] = [];
    for (const r of answers) {
      if (r.status < 200 || r.status >= 300) {
        void r.arrayBuffer().catch(() => {});
        continue;
      }
      try {
        parts.push((await r.json()) as Record<string, unknown>);
      } catch {
        // Left out, as a node that did not answer.
      }
    }
    if (parts.length === 0) return fail(503, UNAVAILABLE);
    return Response.json({ ...sumUsage(parts), nodesDown: all.length - parts.length });
  }

  async function metrics(): Promise<Response> {
    const texts = await Promise.all(
      live().map((n) =>
        fetch(`${n.url}/metrics`, { signal: AbortSignal.timeout(2_000) }).then(
          (r) => (r.ok ? r.text() : ""),
          () => "",
        ),
      ),
    );
    const cell = options.cell === undefined ? "" : `{cell="${options.cell}"}`;
    const cells = options.cell === undefined ? "" : `,cell="${options.cell}"`;
    const own = [
      "# HELP eden_cluster_nodes_up Nodes answering /readyz",
      "# TYPE eden_cluster_nodes_up gauge",
      `eden_cluster_nodes_up${cell} ${live().length}`,
      "# HELP eden_cluster_nodes Nodes listed",
      "# TYPE eden_cluster_nodes gauge",
      `eden_cluster_nodes${cell} ${nodes.length}`,
      "# TYPE eden_cluster_requests_total counter",
      ...[...counts].map(([k, v]) => `eden_cluster_requests_total{outcome="${k}"${cells}} ${v}`),
      "# TYPE eden_cluster_rebalances_total counter",
      `eden_cluster_rebalances_total${cell} ${rebalanceTotal}`,
      "",
    ].join("\n");
    return new Response(sumMetrics([own, ...texts]), { headers: { "content-type": "text/plain; version=0.0.4" } });
  }

  return {
    port: server.port ?? 0,
    get nodes() {
      return nodes;
    },
    owner: (b) => table.owner(b),
    rebalances,
    checkHealth,
    setNodes(specs: NodeSpec[]) {
      if (options.follow) {
        // A follower drives no membership: the list only refreshes the urls it may forward to.
        const byId = new Map(specs.map((s) => [s.id, s]));
        for (const n of nodes) if (byId.has(n.id)) n.url = byId.get(n.id)!.url;
        for (const s of specs) {
          if (!nodes.some((n) => n.id === s.id))
            nodes.push({ ...s, up: false, fails: 0, oks: 0, member: false, draining: false, reset: false });
        }
        return Promise.resolve(null);
      }
      // On `chain` like a health round: its probes, resets and member flags share the same one-at-a-time rule.
      return serialize(async () => {
        const ids = new Set(specs.map((s) => s.id));
        for (const n of nodes) n.member = ids.has(n.id);
        for (const s of specs) {
          const known = nodes.find((n) => n.id === s.id);
          if (known) known.url = s.url;
          else nodes.push({ ...s, up: false, fails: 0, oks: 0, member: true, draining: false, reset: false });
        }
        // A new node joins once it answers: probe the new ones now rather than waiting for the timer's rounds.
        await Promise.all(
          nodes.map(async (n) => {
            if (n.member && !n.up && !n.draining && (await probe(n)) === "up" && (await reset(n))) {
              n.up = true;
              n.oks = recoverAfter;
            }
          }),
        );
        return doRebalance("membership changed");
      });
    },
    async stop() {
      draining = true;
      if (timer) clearInterval(timer);
      if ((config.drainDelayMs ?? 0) > 0) await Bun.sleep(config.drainDelayMs!);
      await Promise.race([server.stop(false), Bun.sleep(grace * 0.4)]);
      void server.stop(true);
    },
  };
}

/** The doc a leader publishes its membership to under the store's prefix: one per
 * cell when the fleet is cell'd (S1-P8). */
export function membershipKey(prefix: string, cell: string | null): string {
  return `${prefix}cluster-membership${cell === null ? "" : `.${cell}`}`;
}

/** `main.ts` with EDEN_NODES or EDEN_NODES_FILE: the cluster router, re-reading the file on SIGHUP or change. */
export async function runCluster(
  config: ServerConfig,
  spec: { nodes: NodeSpec[]; file: string | null; cell: string | null },
): Promise<void> {
  // S1-P7: the membership store is the nodes' EDEN_PERSIST_STORE (the router holds no users, so `config.persist`
  // is not built for it — the same env is read here). `cluster-membership` under the shared prefix names no
  // blob: the sweeps skip it, and under sharding it sits on the first store (S1-P4). A cell'd fleet shares the
  // store across cells, so each cell's doc is its own (S1-P8) — else two cells' leaders would clobber one
  // another's published membership.
  const cfg = storeConfig(process.env);
  const membership =
    cfg === null
      ? undefined
      : {
          store:
            cfg.buckets.length === 1
              ? new S3BlobStore({ ...cfg, bucket: cfg.buckets[0]! })
              : new ShardedBlobStore(
                  cfg.buckets.map((bucket) => new S3BlobStore({ ...cfg, bucket })),
                  cfg.prefix,
                ),
          key: membershipKey(cfg.prefix, spec.cell),
        };
  const follow = process.env.EDEN_CLUSTER_FOLLOW === "1";
  if (follow && membership === undefined)
    throw new Error("EDEN_CLUSTER_FOLLOW needs EDEN_PERSIST_STORE, the store the leader publishes its membership to");
  const router = await startCluster({
    config,
    nodes: spec.nodes,
    membership,
    follow: follow ? {} : undefined,
    cell: spec.cell ?? undefined,
  });
  const reload = () => {
    if (!spec.file) return;
    try {
      void router.setNodes(parseNodes(readFileSync(spec.file, "utf8"), spec.cell ?? undefined));
    } catch (e) {
      console.error(`eden cluster: ${spec.file} not applied: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  process.on("SIGHUP", reload);
  if (spec.file) {
    let pending: ReturnType<typeof setTimeout> | null = null;
    watch(spec.file, () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(reload, 500);
    });
  }
  const stop = () => void router.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(
    `eden cluster router listening on http://${config.host}:${router.port} (${spec.nodes.length} nodes: ` +
      `${spec.nodes.map((n) => n.id).join(", ")}; users placed by rendezvous hashing of their bucket, D992)`,
  );
}

/**
 * The fleet's edge (S1-P8): a stateless router in front of the cells. Each request's user bucket
 * (`bucketOf(tenant, userOf(body))`, the same pure hash the whole fleet shares) picks the cell whose top-table
 * row covers it; the bytes go to that cell's load balancer. No membership, no probes, nothing mutable: the cell
 * LBs health-check their own routers, and the table is static by design — a range move is a deploy-time event,
 * so a changing file is not re-read here (a new table is rolled out as a restart, while a live move between
 * cells rides the store the way a move between nodes does).
 *
 * `/v1/forget` needs only the user's cell (a user lives in exactly one range); `/v1/usage` sums across all of
 * them. GETs and keyless POSTs go to the first row's cell — they carry no body to hash (as the cluster router
 * forwards them to its first live node).
 */
export interface EdgeOptions {
  config: Pick<ServerConfig, "port" | "host" | "keys" | "dev"> &
    Partial<
      Pick<
        ServerConfig,
        "maxBodyBytes" | "tenantRatePerSec" | "tenantBurst" | "shutdownGraceMs" | "drainDelayMs"
      >
    >;
  ranges: TopRange[];
  /** A forwarded request's bound (default 60 s, as the cluster router's). */
  forwardTimeoutMs?: number;
  /** How long a request is retried while the cell's LB refuses connections (a rollout); default 5 s. */
  retryRefusedMs?: number;
}

export interface Edge {
  port: number;
  stop: () => Promise<void>;
}

export async function startEdge(options: EdgeOptions): Promise<Edge> {
  const { config, ranges } = options;
  const forwardTimeoutMs = options.forwardTimeoutMs ?? 60_000;
  const retryRefusedMs = options.retryRefusedMs ?? 5_000;
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });
  const counts = new Map<string, number>();
  const count = (k: string, cell?: string) =>
    counts.set(`${cell ?? ""} ${k}`, (counts.get(`${cell ?? ""} ${k}`) ?? 0) + 1);
  const fail = (status: number, error: string) => Response.json({ error }, { status });
  const cellOf = (b: number) => ranges.find((r) => b >= r.lo && b <= r.hi)!.url;

  const tenantOf = (req: Request): string | null => {
    const key = keyOf(req);
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    return config.dev && !key ? "dev" : null;
  };

  const forward = async (cell: string, req: Request, url: URL, body?: Uint8Array): Promise<Response> => {
    const headers: Record<string, string> = {};
    const auth = req.headers.get("authorization");
    if (auth !== null) headers.authorization = auth;
    const type = req.headers.get("content-type");
    if (type !== null) headers["content-type"] = type;
    // A refused connection is a cell mid-rollout: the request never reached it, so it is retried for up to
    // `retryRefusedMs`. Any other failure is not: an event must not be observed twice (the cluster rule).
    const until = performance.now() + retryRefusedMs;
    for (;;) {
      try {
        return await fetch(`${cell}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          signal: AbortSignal.timeout(forwardTimeoutMs),
        });
      } catch (e) {
        const code = (e as { code?: string } | null)?.code ?? "";
        if (!/ECONNREFUSED|ConnectionRefused/i.test(code) || performance.now() > until)
          return fail(503, "temporarily unable to serve context");
        count("retried_refused", cell);
        await Bun.sleep(200);
      }
    }
  };

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: maxBodyBytes,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ ok: true, cells: ranges.length });
      if (req.method === "GET" && url.pathname === "/readyz")
        return Response.json({ ready: true, cells: ranges.length });
      if (req.method === "GET" && url.pathname === "/metrics") {
        const own = [
          "# HELP eden_edge_cells Cells in the top table",
          "# TYPE eden_edge_cells gauge",
          `eden_edge_cells ${ranges.length}`,
          "# HELP eden_edge_requests_total Requests by outcome and cell",
          "# TYPE eden_edge_requests_total counter",
          ...[...counts].map(([k, v]) => {
            const [cell, outcome] = k.split(" ", 2);
            const labels = cell === "" ? `outcome="${outcome}"` : `cell="${cell}",outcome="${outcome}"`;
            return `eden_edge_requests_total{${labels}} ${v}`;
          }),
          "",
        ].join("\n");
        return new Response(own, { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      if (url.pathname.startsWith("/internal/")) return fail(404, "not found");
      const tenant = tenantOf(req);
      if (req.method !== "POST" || tenant === null) return forward(ranges[0]!.url, req, url);
      if (tenant === "dev" && !keyOf(req) && !keylessOriginAllowed(req.headers.get("origin")))
        return fail(403, "dev mode serves no key-less request from another site's page");
      const waitMs = limiter.take(tenant);
      if (waitMs > 0)
        return Response.json(
          { error: "rate limited" },
          { status: 429, headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) } },
        );
      if (Number(req.headers.get("content-length") ?? NaN) > maxBodyBytes)
        return fail(413, `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`);
      let body: Uint8Array;
      try {
        body = new Uint8Array(await req.arrayBuffer());
      } catch {
        return fail(400, "body could not be read");
      }
      const cell = cellOf(bucketOf(tenant, userOf(body)));
      if (url.pathname === "/v1/usage") {
        // Usage is per tenant across every cell: each answers its users' share (the cluster's `everywhere`).
        const parts: Record<string, unknown>[] = [];
        for (const r of await Promise.all(ranges.map((c) => forward(c.url, req, url, body)))) {
          if (r.status < 200 || r.status >= 300) {
            void r.arrayBuffer().catch(() => {});
            continue;
          }
          try {
            parts.push((await r.json()) as Record<string, unknown>);
          } catch {
            // Left out, as a cell that did not answer.
          }
        }
        if (parts.length === 0) return fail(503, "temporarily unable to serve context");
        return Response.json({ ...sumUsage(parts), cellsDown: ranges.length - parts.length });
      }
      count("forwarded", cell);
      return forward(cell, req, url, body);
    },
    error: () => fail(503, "temporarily unable to serve context"),
  });
  return {
    port: server.port ?? 0,
    // Drains as every server does (D994): the LB's delay, in-flight requests given most of the grace, the rest
    // closed. `server.stop(true)` alone would cut a forwarded request its cell may already have observed.
    async stop() {
      if ((config.drainDelayMs ?? 0) > 0) await Bun.sleep(config.drainDelayMs!);
      const grace = config.shutdownGraceMs ?? 10_000;
      await Promise.race([server.stop(false), Bun.sleep(grace * 0.4)]);
      void server.stop(true);
    },
  };
}

/** `main.ts` with EDEN_TOP_TABLE or EDEN_TOP_TABLE_FILE: the edge over the cells (S1-P8). */
export async function runEdge(config: ServerConfig, spec: { ranges: TopRange[]; file: string | null }): Promise<void> {
  const edge = await startEdge({ config, ranges: spec.ranges });
  const stop = () => void edge.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(
    `eden edge listening on http://${config.host}:${edge.port} (${spec.ranges.length} cell(s): ` +
      `${spec.ranges.map((r) => `${r.lo}-${r.hi}=${r.url}`).join(", ")}; users placed by the top table, S1-P8)`,
  );
}
