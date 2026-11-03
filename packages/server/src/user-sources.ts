/**
 * Per-user sources (D104): each (tenant, user) gets their own sources, built from their own configuration, with
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
 *   within that time; a directory error retires every held source of that user (no stale credentials are kept in use).
 * - `forget(scope)` (POST /v1/forget) closes the user's connections and drops the entry; `forget(scope, id)` closes
 *   one. A user not resolved for `idleMs` (default 15 min) is closed by the sweep; past `maxUsers` the least recently
 *   used is closed. A held source handed out before a close refuses further calls, and a call that was in flight
 *   when it was closed closes the connection again when it settles, so no reconnect outlives the close.
 * - Read-only (D7) is untouched: every MCP source is an `McpSource`, which runs its own check on connect.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isId, scopeKey, type Scope } from "@eden/protocol";
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
  searchTool: McpSourceOptions["searchTool"];
  fetchTool?: McpSourceOptions["fetchTool"];
  listTool?: McpSourceOptions["listTool"];
  trustedReadTools?: string[];
}

export type SourceSpec = StaticSpec | McpSpec;

/** One user's source specs. May be async (a vault). A throw is that user's configuration error. */
export type SourceDirectory = (scope: Scope) => Promise<SourceSpec[]> | SourceSpec[];

/** A source configuration that cannot be used; the message names the field. */
export class SourceConfigError extends Error {}

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_SPEC_TTL_MS = 60_000;
const DEFAULT_MAX_USERS = 10_000;
const SWEEP_MS = 60_000;

export interface UserSourcesOptions {
  directory: SourceDirectory;
  /** Sources every user gets beside their own (EDEN_SOURCES_FILE: static only). A user's own source wins an id. */
  shared?: Source[];
  idleMs?: number;
  specTtlMs?: number;
  maxUsers?: number;
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
  /** Least recently used first: `sources` re-inserts, so the sweep and the cap read from the front. */
  private readonly users = new Map<string, UserEntry>();
  private readonly idleMs: number;
  private readonly specTtlMs: number;
  private readonly maxUsers: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: UserSourcesOptions) {
    this.idleMs = o.idleMs ?? DEFAULT_IDLE_MS;
    this.specTtlMs = o.specTtlMs ?? DEFAULT_SPEC_TTL_MS;
    this.maxUsers = o.maxUsers ?? DEFAULT_MAX_USERS;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(m));
  }

  /** The resolver to hand to `buildPartner`. Rejects with `SourceConfigError` when the user's config is broken. */
  readonly resolver: SourceResolver = (scope) => this.sources(scope);

  /** Starts the idle sweep (unref'd: it never keeps the process alive). */
  start(): this {
    this.timer ??= setInterval(() => this.sweep(), SWEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }

  async sources(scope: Scope): Promise<Source[]> {
    const u = await this.ready(scope);
    if (u.error !== null) throw new SourceConfigError(u.error);
    const own = [...u.held.values()].map((h) => h.lease as Source);
    const shared = (this.o.shared ?? []).filter((s) => !u.held.has(s.id));
    return [...shared, ...own];
  }

  /** The user's sources and configuration error, without opening a connection. */
  async status(scope: Scope): Promise<UserSourcesStatus> {
    const u = await this.ready(scope);
    if (u.error !== null) return { sources: [], error: u.error };
    const list = await this.sources(scope);
    return { sources: list.map((s) => ({ id: s.id, kind: s.kind })), error: null };
  }

  /** Closes the user's connections (all, or one source's) and, for the whole user, drops their entry. */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    const u = this.users.get(key);
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
    for (const u of [...this.users.values()]) {
      if (u.usedAt > cutoff) break; // LRU order: the rest are newer
      this.drop(u);
    }
  }

  /** Closes everything and stops the sweep. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of [...this.users.values()]) this.drop(u);
  }

  /** Users with an entry (tests, stats). */
  get size(): number {
    return this.users.size;
  }

  private async ready(scope: Scope): Promise<UserEntry> {
    const key = scopeKey(scope);
    const now = this.now();
    let u = this.users.get(key);
    if (u) this.users.delete(key);
    else {
      const own = { tenantId: scope.tenantId, userId: scope.userId };
      u = { scope: own, key, held: new Map(), usedAt: now, specsAt: -Infinity, loading: null, error: null };
    }
    this.users.set(key, u);
    u.usedAt = now;
    while (this.users.size > this.maxUsers) {
      const oldest = this.users.values().next().value!;
      this.drop(oldest);
    }
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
      specs = checkSpecs(await this.o.directory(u.scope), `sources of ${u.key}`);
    } catch (e) {
      if (this.users.get(u.key) !== u) return;
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
    if (this.users.get(u.key) !== u) return;
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

  private drop(u: UserEntry): void {
    if (this.users.get(u.key) === u) this.users.delete(u.key);
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
export function checkSpecs(raw: unknown, where: string): SourceSpec[] {
  if (!Array.isArray(raw)) throw new SourceConfigError(`${where} must be an array of sources`);
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
  });
  return raw as SourceSpec[];
}

interface UsersFile {
  users: Map<string, SourceSpec[]>;
}

/**
 * EDEN_USER_SOURCES_FILE as a directory: `{"users": {"<tenant>/<user>": [spec, ...]}}`. Checked in full when read: a
 * bad entry anywhere stops startup with a message naming it, and every `{"env"}` header must be set. The file is
 * re-read when its modification time changes (checked at most every 5 s); a re-read that fails the check keeps the
 * last good file and logs why. A user not in the file has no sources of their own.
 */
export function fileDirectory(path: string, log: (m: string) => void = (m) => console.error(m)): SourceDirectory {
  let current = readUsersFile(path);
  let mtime = statSync(path).mtimeMs;
  let checkedAt = Date.now();
  return (scope) => {
    const now = Date.now();
    if (now - checkedAt >= 5_000) {
      checkedAt = now;
      try {
        const m = statSync(path).mtimeMs;
        if (m !== mtime) {
          mtime = m;
          current = readUsersFile(path);
        }
      } catch (e) {
        log(
          `eden: EDEN_USER_SOURCES_FILE not re-read, keeping the last good one: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return current.users.get(scopeKey(scope)) ?? [];
  };
}

function readUsersFile(path: string): UsersFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SourceConfigError(`EDEN_USER_SOURCES_FILE ${path}: ${e instanceof Error ? e.message : e}`);
  }
  if (!isObject(raw) || !isObject(raw.users)) {
    throw new SourceConfigError(`EDEN_USER_SOURCES_FILE must be {"users": {"<tenant>/<user>": [sources]}}`);
  }
  const users = new Map<string, SourceSpec[]>();
  for (const [key, list] of Object.entries(raw.users)) {
    const slash = key.indexOf("/");
    if (slash < 0 || !isId(key.slice(0, slash)) || !isId(key.slice(slash + 1))) {
      throw new SourceConfigError(`EDEN_USER_SOURCES_FILE key "${key}" must be "<tenantId>/<userId>"`);
    }
    const specs = checkSpecs(list, `EDEN_USER_SOURCES_FILE users["${key}"]`);
    for (const s of specs) {
      if (s.kind !== "mcp") continue;
      if (s.transport !== undefined) throw new SourceConfigError(`users["${key}"] ${s.id}: a file source needs a url`);
      // Fails here, at startup, rather than at the user's first lookup.
      resolveHeaders(s.headers ?? {}, `users["${key}"] ${s.id}`);
    }
    users.set(key, specs);
  }
  return { users };
}
