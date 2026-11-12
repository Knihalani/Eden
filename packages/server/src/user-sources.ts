/**
 * Per-user sources (D108): each (tenant, user) gets their own sources, built from their own configuration, with
 * their own credentials, and their own MCP connections, never shared with another user.
 *
 * An integrator supplies a `SourceDirectory`: given a scope, the user's source specs (static documents, or an MCP
 * server over streamable HTTP with the user's headers). `fileDirectory` is one, reading EDEN_USER_SOURCES_FILE; an
 * embedding can pass its own (reading the user's connected accounts and their tokens from a vault).
 *
 * `UserSources` turns specs into sources and holds them per scope:
 * - Connections are opened lazily (McpSource connects on first search) and cached per scope and source id. A spec
 *   whose fingerprint changes (a new token, a new URL) closes the old connection and builds a new one.
 * - The directory is asked again at most every `specTtlMs` (default 60 s), so a revoked account stops being read
 *   within that time; a directory error, or no answer within `directoryTimeoutMs` (5 s), retires every held source
 *   of that user (no stale credentials are kept in use) and leaves them the shared sources only.
 * - `forget(scope)` (POST /v1/forget) closes the user's connections and drops the entry; `forget(scope, id)` closes
 *   one. A user not resolved for `idleMs` (default 15 min) is closed by the sweep (background sync, D57, resolves its
 *   users on every step, so a synced user stays open); past `maxUsersPerTenant` that tenant's least recently used
 *   is closed. A held source handed out before a close refuses further calls, and a call that was in flight
 *   when it was closed closes the connection again when it settles, so no reconnect outlives the close.
 * - Read-only (D7) is untouched: every MCP source is an `McpSource`, which runs its own check on connect.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isId, scopeKey, type Scope } from "@eden/protocol";
import { expandPreset } from "./connector-presets";
import {
  McpSource,
  StaticSource,
  type McpSourceOptions,
  type SearchQuery,
  type Source,
  type SourceResolver,
  type StaticDoc,
} from "@eden/sources";

/** A header's value: the literal, or the name of an environment variable holding it (keeps tokens out of files). */
export type HeaderValue = string | { env: string };

export interface StaticSpec {
  kind: "static";
  id: string;
  description: string;
  docs: StaticDoc[];
}

export interface McpSpec {
  kind: "mcp";
  id: string;
  description: string;
  /** The user's MCP server over streamable HTTP. One of `url` or `transport`. */
  url?: string;
  /** Sent on every request to `url`: the user's own credentials (`Authorization`). Never another user's. */
  headers?: Record<string, HeaderValue>;
  /**
   * Builds the transport (an embedding's own, or a test's in-memory pair). Compared by identity, since it may close
   * over a credential: return the same function while the connection is unchanged, or the connection is rebuilt each
   * time the directory is asked (every `specTtlMs`).
   */
  transport?: () => Transport;
  /**
   * Put credentials in `headers` (or `transport`), never in an `args` closure: `args` is compared by its source text,
   * so a rotated token captured there would not rebuild the connection.
   */
  searchTool: McpSourceOptions["searchTool"];
  fetchTool?: McpSourceOptions["fetchTool"];
  listTool?: McpSourceOptions["listTool"];
  trustedReadTools?: string[];
  /**
   * The integrator forwards this source's change notifications (`POST /v1/sources/changed` or `/v1/sources/items`):
   * with `syncPush`, its synced copy is polled when told it changed rather than on a guess.
   */
  notifies?: boolean;
  /**
   * Each call is billed by the connector's transport (Arcade.dev, Pipedream Connect, Zapier MCP class): the freshness
   * floor (`syncActivePollMs`, D1131) leaves this source to its learned rate unless the deployment opts in
   * (`syncActivePollPriced`). Absent: first-party or flat-rate.
   */
  callPriced?: boolean;
}

export type SourceSpec = StaticSpec | McpSpec;

/**
 * An MCP spec by preset (D294): a common server's read tools filled in by `checkSpecs` (`connector-presets.ts`); any
 * field given here wins over the preset's.
 */
export type PresetSpec = Omit<McpSpec, "kind" | "description" | "searchTool"> &
  Partial<Pick<McpSpec, "description" | "searchTool">> & { kind?: "mcp"; preset: string };

/** One user's source specs. May be async (a vault). A throw is that user's configuration error. */
export type SourceDirectory = (scope: Scope) => Promise<(SourceSpec | PresetSpec)[]> | (SourceSpec | PresetSpec)[];

/** A source configuration that cannot be used; the message names the field. */
export class SourceConfigError extends Error {}

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_SPEC_TTL_MS = 60_000;
const DEFAULT_MAX_USERS_PER_TENANT = 10_000;
const DEFAULT_DIRECTORY_TIMEOUT_MS = 5_000;
const SWEEP_MS = 60_000;

export interface UserSourcesOptions {
  directory: SourceDirectory;
  /** Sources every user gets beside their own (EDEN_SOURCES_FILE: static only). A user's own source wins an id. */
  shared?: Source[];
  idleMs?: number;
  specTtlMs?: number;
  /** Users held per tenant; past it the tenant's least recently used is closed (one tenant never evicts another). */
  maxUsersPerTenant?: number;
  /** A directory call slower than this is that user's error (default 5 s): a stuck vault keeps no old credential. */
  directoryTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** What `/v1/sources` reports for one user: their source ids and kinds, or their configuration error. */
export interface UserSourcesStatus {
  sources: { id: string; kind: string }[];
  error: string | null;
}

interface Held {
  lease: Lease;
  fingerprint: string;
}

interface UserEntry {
  scope: Scope;
  key: string;
  held: Map<string, Held>;
  usedAt: number;
  /** When the directory last answered (or failed); -Infinity before the first answer. */
  specsAt: number;
  loading: Promise<void> | null;
  error: string | null;
}

export class UserSources {
  /** Per tenant, least recently used first: `ready` re-inserts, so the sweep and the cap read from the front. */
  private readonly tenants = new Map<string, Map<string, UserEntry>>();
  private readonly idleMs: number;
  private readonly specTtlMs: number;
  private readonly maxUsersPerTenant: number;
  private readonly directoryTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: UserSourcesOptions) {
    this.idleMs = o.idleMs ?? DEFAULT_IDLE_MS;
    this.specTtlMs = o.specTtlMs ?? DEFAULT_SPEC_TTL_MS;
    this.maxUsersPerTenant = o.maxUsersPerTenant ?? DEFAULT_MAX_USERS_PER_TENANT;
    this.directoryTimeoutMs = o.directoryTimeoutMs ?? DEFAULT_DIRECTORY_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(m));
  }

  /** The resolver to hand to `buildPartner`. A user whose config is broken gets the shared sources only. */
  readonly resolver: SourceResolver = (scope) => this.sources(scope);

  /** Starts the idle sweep (unref'd: it never keeps the process alive). */
  start(): this {
    this.timer ??= setInterval(() => this.sweep(), SWEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  async sources(scope: Scope): Promise<Source[]> {
    return this.listOf(await this.ready(scope));
  }

  /** The user's sources and configuration error (read from one state), without opening a connection. */
  async status(scope: Scope): Promise<UserSourcesStatus> {
    const u = await this.ready(scope);
    if (u.error !== null) return { sources: [], error: u.error };
    return { sources: this.listOf(u).map((s) => ({ id: s.id, kind: s.kind })), error: null };
  }

  /** Closes the user's connections (all, or one source's) and, for the whole user, drops their entry. */
  forget(scope: Scope, sourceId?: string): void {
    const u = this.tenants.get(scope.tenantId)?.get(scopeKey(scope));
    if (!u) return;
    if (sourceId === undefined) {
      this.drop(u);
      return;
    }
    const h = u.held.get(sourceId);
    if (!h) return;
    u.held.delete(sourceId);
    // Asked again on the next lookup: the source comes back only if the directory still lists it.
    u.specsAt = -Infinity;
    h.lease.retire();
  }

  /** Closes every user idle past `idleMs`. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const users of [...this.tenants.values()]) {
      for (const u of [...users.values()]) {
        if (u.usedAt > cutoff) break; // LRU order: the rest of this tenant's are newer
        this.drop(u);
      }
    }
  }

  /** Closes everything and stops the sweep. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const users of [...this.tenants.values()]) for (const u of [...users.values()]) this.drop(u);
  }

  /** Users with an entry, across tenants (tests, stats). */
  get size(): number {
    let n = 0;
    for (const users of this.tenants.values()) n += users.size;
    return n;
  }

  /** Shared sources (minus ids the user has their own of) and the user's own; shared only on a config error. */
  private listOf(u: UserEntry): Source[] {
    const own = [...u.held.values()].map((h) => h.lease as Source);
    const shared = (this.o.shared ?? []).filter((s) => !u.held.has(s.id));
    return [...shared, ...own];
  }

  private isCurrent(u: UserEntry): boolean {
    return this.tenants.get(u.scope.tenantId)?.get(u.key) === u;
  }

  private async ready(scope: Scope): Promise<UserEntry> {
    const key = scopeKey(scope);
    const now = this.now();
    let users = this.tenants.get(scope.tenantId);
    if (!users) this.tenants.set(scope.tenantId, (users = new Map()));
    let u = users.get(key);
    if (u) users.delete(key);
    else {
      const own = { tenantId: scope.tenantId, userId: scope.userId };
      u = { scope: own, key, held: new Map(), usedAt: now, specsAt: -Infinity, loading: null, error: null };
    }
    users.set(key, u);
    u.usedAt = now;
    // Per tenant: a tenant making up user ids evicts only its own users.
    while (users.size > this.maxUsersPerTenant) this.drop(users.values().next().value!);
    if (now - u.specsAt >= this.specTtlMs && !u.loading) {
      const entry = u;
      entry.loading = this.refresh(entry).finally(() => (entry.loading = null));
    }
    // Wait only for the first answer; after that, lookups use what is held while the directory is asked again.
    if (u.loading && u.specsAt === -Infinity) await u.loading;
    return u;
  }

  private async refresh(u: UserEntry): Promise<void> {
    let specs: SourceSpec[];
    try {
      specs = checkSpecs(await this.ask(u.scope), `sources of ${u.key}`);
    } catch (e) {
      if (!this.isCurrent(u)) return;
      const message = e instanceof Error ? e.message : String(e);
      if (message !== u.error) this.log(`eden: sources of ${u.key} not served: ${message}`);
      u.error = message;
      u.specsAt = this.now();
      // A broken configuration (or a vault that cannot answer) keeps no connection in use on old credentials.
      for (const h of u.held.values()) h.lease.retire();
      u.held.clear();
      return;
    }
    // Forgotten (or evicted) while the directory answered: build nothing for it.
    if (!this.isCurrent(u)) return;
    u.error = null;
    u.specsAt = this.now();
    const next = new Map<string, Held>();
    for (const spec of specs) {
      const fingerprint = fingerprintOf(spec);
      const old = u.held.get(spec.id);
      if (old && old.fingerprint === fingerprint) {
        next.set(spec.id, old);
        continue;
      }
      try {
        next.set(spec.id, { lease: new Lease(build(spec)), fingerprint });
      } catch (e) {
        // A spec that passed the check but cannot be built (an env header unset since): skip it, say so.
        this.log(`eden: source ${spec.id} of ${u.key} not served: ${e instanceof Error ? e.message : e}`);
      }
    }
    for (const [id, h] of u.held) if (next.get(id) !== h) h.lease.retire();
    u.held = next;
  }

  /** The directory's answer, or a `SourceConfigError` past `directoryTimeoutMs`. */
  private async ask(scope: Scope): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SourceConfigError(`the source directory did not answer in ${this.directoryTimeoutMs} ms`)),
        this.directoryTimeoutMs,
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(() => this.o.directory(scope)), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private drop(u: UserEntry): void {
    if (this.isCurrent(u)) {
      const users = this.tenants.get(u.scope.tenantId)!;
      users.delete(u.key);
      if (users.size === 0) this.tenants.delete(u.scope.tenantId);
    }
    for (const h of u.held.values()) h.lease.retire();
    u.held.clear();
  }
}

/**
 * A held source as handed to the engine. After `retire` it refuses calls, and a call in flight at the close closes
 * the connection again when it settles: McpSource reconnects lazily, and a connect racing the close would otherwise
 * leave a connection nobody holds.
 */
class Lease implements Source {
  readonly kind: string;
  readonly id: string;
  readonly description: string;
  readonly fetch?: Source["fetch"];
  readonly list?: Source["list"];
  private retired = false;

  constructor(private readonly inner: Source) {
    this.kind = inner.kind;
    this.id = inner.id;
    this.description = inner.description;
    if (inner.fetch) this.fetch = (ref, scope, signal) => this.call(() => inner.fetch!(ref, scope, signal));
    if (inner.list) {
      this.list = (scope, cursor, limit, signal) => this.call(() => inner.list!(scope, cursor, limit, signal));
    }
  }

  get listsByTime(): boolean {
    return this.inner.listsByTime === true;
  }

  get notifies(): boolean {
    return this.inner.notifies === true;
  }

  get callPriced(): boolean {
    return this.inner.callPriced === true;
  }

  get fetchReportsGone(): boolean {
    return this.inner.fetchReportsGone === true;
  }

  get fetchesById(): boolean {
    return this.inner.fetchesById ?? this.inner.fetchReportsGone === true;
  }

  search(query: SearchQuery, signal: AbortSignal) {
    return this.call(() => this.inner.search(query, signal));
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    void this.inner.close?.().catch(() => {});
  }

  private async call<T>(f: () => Promise<T>): Promise<T> {
    if (this.retired) throw new Error(`${this.id}: source closed (forgotten, idle or reconfigured)`);
    try {
      return await f();
    } finally {
      if (this.retired) void this.inner.close?.().catch(() => {});
    }
  }
}

function build(spec: SourceSpec): Source {
  if (spec.kind === "static") return new StaticSource(spec.id, spec.description, spec.docs);
  let transport = spec.transport;
  if (!transport) {
    const url = new URL(spec.url!);
    // Read here, per user and per build: one user's headers never reach another user's transport.
    const headers = resolveHeaders(spec.headers ?? {}, spec.id);
    transport = () => new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  return new McpSource({
    id: spec.id,
    description: spec.description,
    transport,
    searchTool: spec.searchTool,
    fetchTool: spec.fetchTool,
    listTool: spec.listTool,
    trustedReadTools: spec.trustedReadTools,
    ...(spec.notifies === true ? { notifies: true } : {}),
    ...(spec.callPriced === true ? { callPriced: true } : {}),
  });
}

function resolveHeaders(raw: Record<string, HeaderValue>, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(raw)) {
    if (typeof v === "string") out[name] = v;
    else {
      const value = process.env[v.env];
      if (!value) throw new SourceConfigError(`${id}: header ${name} names ${v.env}, which is not set`);
      out[name] = value;
    }
  }
  return out;
}

/**
 * `transport` is compared by identity (a counter per function object), since it may close over a credential; other
 * functions (`args`) by their source text, so an inline arrow rebuilt on every directory call is not a change.
 */
const fnIds = new WeakMap<object, number>();
let nextFnId = 0;
function fingerprintOf(spec: SourceSpec): string {
  const json = JSON.stringify(spec, (k, v: unknown) => {
    if (typeof v !== "function") return v;
    if (k !== "transport") return `fn:${String(v)}`;
    let n = fnIds.get(v);
    if (n === undefined) fnIds.set(v, (n = ++nextFnId));
    return `fn#${n}`;
  });
  // A hash, so no credential is kept twice in memory as a map key.
  return createHash("sha256").update(json).digest("hex");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Checks a list of specs (from a file or a directory); throws `SourceConfigError` naming the first bad field. */
export function checkSpecs(input: unknown, where: string): SourceSpec[] {
  if (!Array.isArray(input)) throw new SourceConfigError(`${where} must be an array of sources`);
  // A `preset` (D294) fills in a common server's read tools before anything is checked, so the expanded spec meets
  // every rule below (and McpSource's read-only check on connect) like one written out by hand.
  const raw = input.map((s, i) => {
    if (!isObject(s)) throw new SourceConfigError(`${where}[${i}] must be an object`);
    try {
      return expandPreset(s);
    } catch (e) {
      throw new SourceConfigError(`${where}[${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  const seen = new Set<string>();
  raw.forEach((s, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(s)) throw new SourceConfigError(`${at} must be an object`);
    if (!isId(s.id)) throw new SourceConfigError(`${at}.id must be 1-128 characters of [A-Za-z0-9._:@-]`);
    if (seen.has(s.id)) throw new SourceConfigError(`${at}.id "${s.id}" is listed twice`);
    seen.add(s.id);
    if (typeof s.description !== "string") throw new SourceConfigError(`${at}.description must be a string`);
    if (s.kind === "static") {
      const docs = s.docs;
      if (!Array.isArray(docs)) throw new SourceConfigError(`${at}.docs must be an array`);
      docs.forEach((d, j) => {
        if (!isObject(d) || typeof d.ref !== "string" || typeof d.title !== "string" || typeof d.text !== "string") {
          throw new SourceConfigError(`${at}.docs[${j}] needs string ref, title and text`);
        }
      });
      return;
    }
    if (s.kind !== "mcp") throw new SourceConfigError(`${at}.kind must be "static" or "mcp"`);
    if ((s.url === undefined) === (s.transport === undefined)) {
      throw new SourceConfigError(`${at} needs exactly one of url or transport`);
    }
    if (s.url !== undefined) {
      let url: URL;
      try {
        url = new URL(String(s.url));
      } catch {
        throw new SourceConfigError(`${at}.url is not a URL`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new SourceConfigError(`${at}.url must be http(s)`);
      }
    }
    if (s.transport !== undefined && typeof s.transport !== "function") {
      throw new SourceConfigError(`${at}.transport must be a function`);
    }
    if (s.headers !== undefined) {
      if (!isObject(s.headers)) throw new SourceConfigError(`${at}.headers must be an object`);
      for (const [name, v] of Object.entries(s.headers)) {
        const ok = typeof v === "string" || (isObject(v) && typeof v.env === "string" && v.env.length > 0);
        if (!ok) throw new SourceConfigError(`${at}.headers.${name} must be a string or {"env": "NAME"}`);
      }
    }
    for (const role of ["searchTool", "fetchTool", "listTool"] as const) {
      const t = s[role];
      if (t === undefined && role !== "searchTool") continue;
      if (!isObject(t) || typeof t.name !== "string" || !t.name) {
        throw new SourceConfigError(`${at}.${role}.name must be a tool name`);
      }
      if (t.fixed !== undefined && !isObject(t.fixed))
        throw new SourceConfigError(`${at}.${role}.fixed must be an object`);
      if (t.args !== undefined && typeof t.args !== "function") {
        throw new SourceConfigError(`${at}.${role}.args must be a function`);
      }
    }
    const trusted = s.trustedReadTools;
    if (trusted !== undefined && !(Array.isArray(trusted) && trusted.every((x) => typeof x === "string"))) {
      throw new SourceConfigError(`${at}.trustedReadTools must be an array of tool names`);
    }
    if (s.notifies !== undefined && typeof s.notifies !== "boolean") {
      throw new SourceConfigError(`${at}.notifies must be true or false`);
    }
    if (s.callPriced !== undefined && typeof s.callPriced !== "boolean") {
      throw new SourceConfigError(`${at}.callPriced must be true or false`);
    }
  });
  return raw as unknown as SourceSpec[];
}

/** Each user's specs, or the message of what is wrong with their entry. */
export type UsersFile = Map<string, SourceSpec[] | { error: string }>;

export interface FileDirectoryOptions {
  /** Only this scope's entry is read and checked (the stdio server, one user per process). */
  only?: Scope;
  log?: (m: string) => void;
  now?: () => number;
}

/**
 * EDEN_USER_SOURCES_FILE as a directory: `{"users": {"<tenant>/<user>": [spec, ...]}}`. At startup it is checked in
 * full: a bad entry anywhere (or an `{"env"}` header whose variable is unset) stops startup with a message naming it.
 * The file is re-read when its modification time changes (checked at most every 5 s), entry by entry: a user whose
 * new entry is broken gets that as their configuration error (their connections close), a user no longer listed has
 * no sources of their own, and the others take their new entries, so one typo does not hold back a revocation. A
 * re-read of a file that is not valid JSON or not `{"users": {...}}` keeps the last good one and logs why, and is
 * tried again at the next check.
 */
export function fileDirectory(path: string, options: FileDirectoryOptions = {}): SourceDirectory {
  const log = options.log ?? ((m: string) => console.error(m));
  const only = options.only ? scopeKey(options.only) : undefined;
  let mtime = statSync(path).mtimeMs;
  let current = readUsersFile(path, only);
  for (const entry of current.values()) if (!Array.isArray(entry)) throw new SourceConfigError(entry.error);
  const clock = options.now ?? Date.now;
  let checkedAt = clock();
  return (scope) => {
    const now = clock();
    if (now - checkedAt >= 5_000) {
      checkedAt = now;
      try {
        const m = statSync(path).mtimeMs;
        if (m !== mtime) {
          current = readUsersFile(path, only);
          // Only after a good read: a half-written file read within one mtime tick is read again next time.
          mtime = m;
        }
      } catch (e) {
        log(
          `eden: EDEN_USER_SOURCES_FILE not re-read, keeping the last good one: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    const entry = current.get(scopeKey(scope)) ?? [];
    if (!Array.isArray(entry)) throw new SourceConfigError(entry.error);
    return entry;
  };
}

export function readUsersFile(path: string, only?: string): UsersFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Not the parser's message: it can quote a word of the file, and the file holds credentials (logged on re-read).
    const why = e instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
    throw new SourceConfigError(`EDEN_USER_SOURCES_FILE ${path} ${why}`);
  }
  if (!isObject(raw) || !isObject(raw.users)) {
    throw new SourceConfigError(`EDEN_USER_SOURCES_FILE must be {"users": {"<tenant>/<user>": [sources]}}`);
  }
  const users: UsersFile = new Map();
  for (const [key, list] of Object.entries(raw.users)) {
    if (only !== undefined && key !== only) continue;
    try {
      users.set(key, checkEntry(key, list));
    } catch (e) {
      users.set(key, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return users;
}

function checkEntry(key: string, list: unknown): SourceSpec[] {
  const slash = key.indexOf("/");
  if (slash < 0 || !isId(key.slice(0, slash)) || !isId(key.slice(slash + 1))) {
    throw new SourceConfigError(`EDEN_USER_SOURCES_FILE key "${key}" must be "<tenantId>/<userId>"`);
  }
  const specs = checkSpecs(list, `EDEN_USER_SOURCES_FILE users["${key}"]`);
  for (const s of specs) {
    if (s.kind !== "mcp") continue;
    if (s.transport !== undefined) throw new SourceConfigError(`users["${key}"] ${s.id}: a file source needs a url`);
    // Checked when read, so an unset variable is named at startup rather than at the user's first lookup.
    resolveHeaders(s.headers ?? {}, `users["${key}"] ${s.id}`);
  }
  return specs;
}
