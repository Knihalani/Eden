/**
 * The machinery every personal-agent surface was reimplementing (pi, openclaw, opencode — D1997):
 * hosted-or-local resolution, the shared-daemon endpoint (D1993), one `SurfaceSession` per
 * conversation holding the dedup/kept/trailing bookkeeping, respawn re-attach on generation
 * change, the serialized report queue, and session teardown. A surface keeps only what is
 * genuinely its agent's: message shapes and keying, event mapping, session-id lookup, hook
 * registration, and packet placement.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EdenClient, edenId, type EdenClientOptions } from "./client";
import { LocalEden, resolveLocalEden } from "./local";
import type { Injection } from "@eden/protocol";

/** A packet's placement cap (D336): kept text and the replay list each shed the oldest over it. */
export const MAX_KEPT_BYTES = 64_000;
/** A session's seen-dedup bound: the oldest entries go once it is passed. */
export const MAX_SEEN = 4_000;

/** A text-bearing content block, the shape every agent's message union shares. */
export interface TextBlock {
  type?: string;
  text?: string;
}

export function envOf(
  name: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** The text of a string-or-blocks `content` field: the `type === "text"` blocks joined. */
export function textOf(content: string | TextBlock[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * One conversation's bookkeeping on a surface. `V` is the kept-placement value: most surfaces
 * place packet text (`string`); opencode anchors packets to message ids, so it keeps
 * `{ text, messageID }`. `copyCounts`/`reportedAssistant`/`reportedCalls` are the transcript-dedup
 * sets a surface whose hooks replay whole transcripts needs; surfaces that don't just never read them.
 */
export interface SurfaceSession<V = string> {
  eden: EdenClient;
  /** Client options minus the ids each session supplies — kept for the rebuild a sidecar restart needs. */
  options: Omit<EdenClientOptions, "sessionId">;
  /** The Eden session id (after `edenId`), kept for the same rebuild. */
  sessionId: string;
  /** The sidecar generation the client was built against. */
  generation: number | string;
  /** Message keys already reported (bounded by `dedupe`). */
  seen: Map<string, number>;
  /** Content key -> transcript copies reported, so replayed transcripts take the next copy number. */
  copyCounts: Map<string, number>;
  /** Content keys already reported by reply hooks, for transcript-level dedup. */
  reportedAssistant: Set<string>;
  /** Placement key -> packet text kept in place while its message stays live. */
  kept: Map<string, V>;
  /** Mid-turn packets appended to context on later calls. */
  trailing: string[];
  /** The serialized report queue: every observe chain runs after it. */
  reported: Promise<unknown>;
  /** Injections produced off the model path, placed on the next call. */
  queued: Injection[];
  /** A restarted session reports only its latest user message until the first context call is done. */
  firstCall: boolean;
  /** The shared daemon this surface attached to (null on hosted Eden). */
  local: LocalEden | null;
  /** Tool-call ids already reported as tool_call. */
  reportedCalls: Set<string>;
  /** Tool-call ids already reported as tool_result (a blocked call must not report twice). */
  reportedResults: Set<string>;
}

export interface LocalSurfaceOptions {
  /** The plugin's own directory — `resolveLocalEden`'s `pluginDir`. */
  pluginDir: string;
  /**
   * The agent's home (`~/.pi`, the OpenClaw home, …): sources, data, logs and the endpoint file
   * live under `<home>/eden`. A function is resolved per session — for surfaces whose home is
   * read from the environment each time (OpenClaw's `OPENCLAW_HOME`).
   */
  home: string | (() => string);
  /** Extra directories `resolveLocalEden` tries for the bundled `eden-local`, from the resolved home. */
  fallbackDirs?: string[] | ((home: string) => string[]);
  /** The environment EDEN_* vars are read from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

export interface LocalSurface<V = string> {
  /** Live sessions. Surfaces re-export or stash this for tests that seed stub Eden clients. */
  readonly sessions: Map<string, SurfaceSession<V>>;
  /** The session for an agent-side id (created with a `session_start` report on first use),
   * or null when no Eden is reachable. */
  sessionFor(sessionId: string): Promise<SurfaceSession<V> | null>;
  /** The session's client, rebuilt on the sidecar's new endpoint after a respawn; null when the daemon is down. */
  liveClient(s: SurfaceSession<V>): Promise<EdenClient | null>;
  /** True when `key` was already reported; records it (bounded by `MAX_SEEN`) otherwise. */
  dedupe(s: SurfaceSession<V>, key: string): boolean;
  /** Places `value` on `key`, dropping placements whose message left the window,
   * then the oldest over `MAX_KEPT_BYTES`. */
  keep(map: Map<string, V>, key: string, value: V, live: Set<string>): void;
  /** Appends a mid-turn packet to the replay list, bounded like kept placements. */
  pushTrailing(s: SurfaceSession<V>, text: string): void;
  /** Observes the events on the session's report queue; the last injection returned. */
  report<E extends { kind: string }>(s: SurfaceSession<V>, events: E[], waits: boolean): Promise<Injection | null>;
  /** Drains the session's report queue, detaches its sidecar handle, and drops it. */
  closeSession(key: string): Promise<void>;
  /** `closeSession` for every live session. */
  endAll(): Promise<void>;
}

/**
 * Client options minus the ids each session supplies, plus the sidecar to close at session end:
 * `EDEN_URL` picks hosted Eden; otherwise the `eden-local` binary `resolveLocalEden` finds is
 * spawned (or the daemon already recorded at `<home>/eden/local-endpoint.json` is attached).
 */
async function surfaceClientOptions(opts: LocalSurfaceOptions): Promise<{
  options: Omit<EdenClientOptions, "sessionId">;
  local: LocalEden | null;
  generation: number | string;
} | null> {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const home = typeof opts.home === "function" ? opts.home() : opts.home;
  const resolved = resolveLocalEden(env, {
    pluginDir: opts.pluginDir,
    home,
    fallbackDirs: typeof opts.fallbackDirs === "function" ? opts.fallbackDirs(home) : opts.fallbackDirs,
  });
  if (!resolved) return null;
  if ("baseUrl" in resolved) {
    return {
      options: {
        userId: resolved.userId,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        tenantId: resolved.tenantId,
      },
      local: null,
      generation: 0,
    };
  }
  const resolvedHome = resolved.home;
  const users =
    envOf("EDEN_USER_SOURCES_FILE", env) ??
    (existsSync(join(resolvedHome, "eden", "sources.json")) ? join(resolvedHome, "eden", "sources.json") : undefined);
  const local = new LocalEden([resolved.binary], {
    home: join(resolvedHome, "eden", "data"),
    sourcesFile: envOf("EDEN_SOURCES_FILE", env),
    userSourcesFile: users,
    logPath: join(resolvedHome, "eden", "logs", "eden-local.log"),
    sharePath: join(resolvedHome, "eden", "local-endpoint.json"),
    env,
  });
  const endpoint = await local.endpoint();
  if (!endpoint) return null;
  return {
    options: {
      userId: envOf("EDEN_USER_ID", env) ?? "local",
      baseUrl: endpoint.url,
      apiKey: endpoint.token,
      tenantId: "local",
    },
    local,
    generation: endpoint.generation,
  };
}

export function createLocalSurface<V = string>(opts: LocalSurfaceOptions): LocalSurface<V> {
  const sessions = new Map<string, SurfaceSession<V>>();

  async function sessionFor(sessionId: string): Promise<SurfaceSession<V> | null> {
    const key = edenId(sessionId);
    const existing = sessions.get(key);
    if (existing) return existing;
    const made = await surfaceClientOptions(opts);
    if (!made) return null;
    const eden = new EdenClient({ ...made.options, sessionId: key });
    const session: SurfaceSession<V> = {
      eden,
      options: made.options,
      sessionId: key,
      generation: made.generation,
      local: made.local,
      seen: new Map(),
      copyCounts: new Map(),
      reportedAssistant: new Set(),
      kept: new Map(),
      trailing: [],
      queued: [],
      firstCall: true,
      reportedCalls: new Set(),
      reportedResults: new Set(),
      reported: eden.observe({ kind: "session_start" }, { waitMs: 0 }).then(
        () => undefined,
        () => undefined,
      ),
    };
    sessions.set(key, session);
    return session;
  }

  async function liveClient(s: SurfaceSession<V>): Promise<EdenClient | null> {
    if (!s.local) return s.eden;
    const ep = await s.local.endpoint();
    if (!ep) return null;
    // A restarted sidecar listens on a new port with a new token: rebuild the client on the new endpoint.
    if (ep.generation !== s.generation) {
      s.generation = ep.generation;
      s.eden = new EdenClient({ ...s.options, sessionId: s.sessionId, baseUrl: ep.url, apiKey: ep.token });
    }
    return s.eden;
  }

  function dedupe(s: SurfaceSession<V>, key: string): boolean {
    if (s.seen.has(key)) return true;
    s.seen.set(key, 1);
    if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.keys().next().value!);
    return false;
  }

  function keep(map: Map<string, V>, key: string, value: V, live: Set<string>): void {
    map.set(key, value);
    // Drop placements whose message left the window, then oldest while over the byte cap (D336).
    for (const k of [...map.keys()]) if (!live.has(k)) map.delete(k);
    let bytes = 0;
    for (const t of map.values()) bytes += typeof t === "string" ? t.length : JSON.stringify(t).length;
    for (const k of map.keys()) {
      if (bytes <= MAX_KEPT_BYTES) break;
      const t = map.get(k)!;
      bytes -= typeof t === "string" ? t.length : JSON.stringify(t).length;
      map.delete(k);
    }
  }

  function pushTrailing(s: SurfaceSession<V>, text: string): void {
    s.trailing.push(text);
    // Bound the replay list like kept placements (D336): drop the oldest over the byte cap.
    let bytes = 0;
    for (const t of s.trailing) bytes += t.length;
    while (bytes > MAX_KEPT_BYTES && s.trailing.length > 0) bytes -= s.trailing.shift()!.length;
  }

  function report<E extends { kind: string }>(
    s: SurfaceSession<V>,
    events: E[],
    waits: boolean,
  ): Promise<Injection | null> {
    const run = s.reported.then(async () => {
      let last: Injection | null = null;
      for (const ev of events) {
        const { injection } = await s.eden.observe(ev as never, waits ? {} : { waitMs: 0 });
        if (injection) last = injection;
      }
      return last;
    });
    // The chain binds here, in the one place that knows it: a caller that only awaits the return
    // cannot silently break ordering, and one chain's failure must not stall every later report.
    s.reported = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function closeSession(key: string): Promise<void> {
    const s = sessions.get(key);
    sessions.delete(key);
    if (!s) return;
    try {
      // The agent's conversation ended: report `session_end` so the engine learns "ended" verdicts
      // for the packets it handed — eviction's inferred/expired is the fallback, not the rule.
      await report(s, [{ kind: "session_end" }], false).catch(() => undefined);
      s.local?.close();
    } catch {
      // Closing is best effort.
    }
  }

  async function endAll(): Promise<void> {
    await Promise.all([...sessions.keys()].map(closeSession));
  }

  return {
    sessions,
    sessionFor,
    liveClient,
    dedupe,
    keep,
    pushTrailing,
    report,
    closeSession,
    endAll,
  };
}
