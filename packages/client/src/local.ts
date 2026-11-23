/**
 * Fail-open owner of one local Eden process, the TypeScript port of `eden_client/local.py`: personal-agent
 * integrations written in TS/JS (Pi extensions, OpenClaw plugins, …) get the same local mode Hermes's plugin gets —
 * a bundled `eden-local` binary beside the plugin, spawned on demand, talked to over loopback with a fresh bearer
 * token. The caller owns registration of `close` at exit; nothing here throws to its caller.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** The child sees only these inherited names plus the credential names its sources file asks for. */
const RUNTIME = new Set(
  `PATH SYSTEMROOT WINDIR COMSPEC PATHEXT TEMP TMP TMPDIR HOME USERPROFILE LOCALAPPDATA APPDATA
   LANG LC_ALL LC_CTYPE TZ`.split(/\s+/),
);
const LOG_CAP = 1024 * 1024;

function envOf(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function* credentialNames(value: unknown): Generator<string> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (Object.keys(rec).length === 1 && typeof rec.env === "string") yield rec.env;
    for (const child of Object.values(rec)) yield* credentialNames(child);
  } else if (Array.isArray(value)) {
    for (const child of value) yield* credentialNames(child);
  }
}

/**
 * The spawned Eden's own model configuration (D2109): the OpenAI-compatible endpoint its roles call. These are
 * Eden's settings, not credentials — they pass through `allowed`'s EDEN_ block on purpose, so an embedder whose
 * agent runs on a local model gives its Eden the same. An explicit `LocalEdenOptions` field wins over the
 * owner process's own variable of the same name.
 */
const MODEL_ENV = [
  "EDEN_MODEL",
  "EDEN_MODEL_BASE_URL",
  "EDEN_MODEL_API_KEY",
  "EDEN_MODEL_TIMEOUT_MS",
  // No option of its own: an owner's role allowlist is inherited like the rest of the endpoint's env.
  "EDEN_MODEL_ROLES",
] as const;

function allowed(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    !RUNTIME.has(upper) &&
    !["HOST", "PORT", "PROXY", "OPENROUTER_API_KEY"].includes(upper) &&
    !upper.endsWith("_PROXY") &&
    !["EDEN_", "LD_", "DYLD_", "PYTHON", "BUN_", "NODE_"].some((p) => upper.startsWith(p))
  );
}

export interface LocalEdenOptions {
  /** `eden-local`'s data directory (`EDEN_HOME`). */
  home: string;
  sourcesFile?: string;
  userSourcesFile?: string;
  logPath?: string;
  /**
   * For agents whose events each run in their own process (an opencode plugin, a Pi hook): the first
   * process starts a detached server (EDEN_LOCAL_DETACHED, outliving its spawner), records it at this
   * path, and every later process attaches to it instead of spawning a fresh Eden — which would lose the
   * session state (delivered packets, checked parties) the check depends on.
   */
  sharePath?: string;
  /** The environment the child filters down from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * The model the spawned Eden's roles run on, when it has any (D2109): the model name an OpenAI-compatible
   * endpoint serves (`EDEN_MODEL`). Unset, the owner's own EDEN_MODEL is inherited.
   */
  model?: string;
  /**
   * That model's endpoint (`EDEN_MODEL_BASE_URL`): `http://localhost:11434/v1` for Ollama, `:1234/v1` for
   * LM Studio, or any OpenAI-compatible base URL. Unset, the owner's EDEN_MODEL_BASE_URL is inherited.
   */
  modelBaseUrl?: string;
  /** The endpoint's bearer when it wants one (`EDEN_MODEL_API_KEY`); Ollama and LM Studio need none. */
  modelApiKey?: string;
  /** The roles' call deadline in ms (`EDEN_MODEL_TIMEOUT_MS`). */
  modelTimeoutMs?: number | string;
  readyTimeoutMs?: number;
  /** For the caller's log lines; defaults to `console.error`-style stderr writes. */
  warn?: (problem: string) => void;
}

/** One endpoint per generation; a dead child is restarted lazily on the next `endpoint()` with backoff. */
export class LocalEden {
  private process: ChildProcess | null = null;
  private endpointValue: { url: string; token: string; generation: number | string } | null = null;
  private generation: number | string = 0;
  private attached = false;
  private closed = false;
  private retryAt = 0;
  private backoff = 1;
  private startedAt = 0;
  private pending: Promise<unknown> | null = null;
  /** True when `shareLock` gave up because the lock could not be created at all, not because it was held. */
  private lockFailed = false;
  private readonly warned = new Set<string>();
  private readonly timeout: number;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly command: string[],
    private readonly options: LocalEdenOptions,
  ) {
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.timeout = Math.max(10, Math.min(options.readyTimeoutMs ?? 10_000, 10_000));
  }

  private warn(problem: string): void {
    if (this.warned.has(problem)) return;
    this.warned.add(problem);
    try {
      (this.options.warn ?? ((p) => console.error(`[eden] local server: ${p}`)))(problem);
    } catch {
      // Logging is best effort too.
    }
  }

  private childEnv(token: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined && RUNTIME.has(k)) env[k] = v;
    const names = new Set<string>();
    for (const file of [this.options.userSourcesFile]) {
      if (!file) continue;
      try {
        for (const name of credentialNames(JSON.parse(readFileSync(file, "utf8")))) names.add(name);
      } catch {
        // A sources file that does not parse passes no credentials; the server's own startup reports it.
      }
    }
    for (const name of names) {
      if (allowed(name) && this.env[name] !== undefined) env[name] = this.env[name]!;
    }
    // The embedder's model endpoint for the roles (MODEL_ENV): the option wins, else the owner's own
    // variable of the name — an app whose agent already runs on a local model sets it once for both.
    Object.assign(env, this.modelEnv());
    Object.assign(env, {
      EDEN_LOCAL: "1",
      EDEN_LOCAL_TOKEN: token,
      HOST: "127.0.0.1",
      PORT: "0",
      EDEN_HOME: this.options.home,
    });
    if (this.options.sourcesFile) env.EDEN_SOURCES_FILE = this.options.sourcesFile;
    if (this.options.userSourcesFile) env.EDEN_USER_SOURCES_FILE = this.options.userSourcesFile;
    return env;
  }

  /** Child stderr to a capped log with one `.1` rotation, never blocking the pipe. */
  private pipeStderr(child: ChildProcess): void {
    const path = this.options.logPath;
    const stream = child.stderr;
    if (!path || !stream) {
      stream?.resume();
      return;
    }
    let log: number | null = null;
    let size = 0;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const existing of [path, `${path}.1`]) {
        if (existsSync(existing) && statSync(existing).size > LOG_CAP) truncateSync(existing, LOG_CAP);
      }
      log = openSync(path, "a");
      size = statSync(path).size;
    } catch {
      log = null;
    }
    stream.on("data", (chunk: Buffer) => {
      if (log === null) return;
      try {
        if (size + chunk.length > LOG_CAP) {
          closeSync(log);
          renameSync(path, `${path}.1`);
          log = openSync(path, "w");
          size = 0;
        }
        writeSync(log, chunk);
        size += chunk.length;
      } catch {
        try {
          if (log !== null) closeSync(log);
        } catch {
          // Closed is closed.
        }
        log = null;
      }
    });
    stream.on("end", () => {
      try {
        if (log !== null) closeSync(log);
      } catch {
        // Nothing to close cleanly.
      }
      log = null;
    });
  }

  private stop(): void {
    const child = this.process;
    this.process = null;
    this.endpointValue = null;
    this.attached = false;
    if (!child) return;
    // A shared server outlives this process by design: let it run, just drop our handle.
    if (this.options.sharePath && child.exitCode === null && child.signalCode === null) return;
    try {
      child.stdin?.end();
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2_000);
      killer.unref?.();
      child.once("exit", () => clearTimeout(killer));
      child.kill("SIGTERM");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  private failure(problem: string): void {
    if (this.startedAt && Date.now() - this.startedAt >= 60_000) this.backoff = 1;
    this.stop();
    this.retryAt = Date.now() + this.backoff * 1_000;
    this.backoff = Math.min(60, this.backoff * 2);
    this.warn(problem);
  }

  /**
   * The model env the spawned child gets (MODEL_ENV resolved: option, else the owner's variable).
   * Shared-server records fingerprint it too: a daemon started with other model settings is stale
   * even when its sources are unchanged (D2109).
   */
  private modelEnv(): Record<string, string> {
    const options = {
      EDEN_MODEL: this.options.model,
      EDEN_MODEL_BASE_URL: this.options.modelBaseUrl,
      EDEN_MODEL_API_KEY: this.options.modelApiKey,
      EDEN_MODEL_TIMEOUT_MS:
        this.options.modelTimeoutMs === undefined ? undefined : String(this.options.modelTimeoutMs),
    };
    const out: Record<string, string> = {};
    for (const name of MODEL_ENV) {
      const value = options[name] ?? envOf(this.env, name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  /**
   * The share record's model fingerprint: [name, hash] pairs over the resolved model env, in
   * MODEL_ENV order. The values are hashed: a share file must never carry EDEN_MODEL_API_KEY in
   * cleartext, and the pairs' fixed order keeps the record byte-compatible with the Python client.
   */
  private modelSig(): [string, string][] {
    return Object.entries(this.modelEnv()).map(([name, value]) => [
      name,
      createHash("sha256").update(value).digest("hex"),
    ]);
  }

  /** The configured source files' identity: a server started before they existed/changed is stale. */
  private sourcesSig(): [string, number | null, number | null][] {
    const sig: [string, number | null, number | null][] = [];
    for (const p of [this.options.sourcesFile, this.options.userSourcesFile]) {
      if (!p) continue;
      try {
        const st = statSync(resolve(p), { bigint: true });
        sig.push([String(p), Number(st.mtimeNs), Number(st.size)]);
      } catch {
        sig.push([String(p), null, null]);
      }
    }
    return sig;
  }

  /**
   * A live shared server recorded by an earlier process, else null (and the stale file removed).
   *
   * A recorded daemon that predates the current source configuration is stopped and replaced, else new
   * sessions would keep attaching to a server that knows no sources. Its pid is only signalled when it
   * answered healthz — the file pairs pid with the server, so the pid is still that daemon's (a recycled
   * dead pid belongs to something else and is left alone).
   */
  private async attach(): Promise<{ url: string; token: string; generation: number | string } | null> {
    const share = this.options.sharePath!;
    let data: {
      url?: unknown;
      token?: unknown;
      generation?: unknown;
      pid?: unknown;
      sources?: unknown;
      model?: unknown;
    };
    try {
      data = JSON.parse(readFileSync(share, "utf8"));
    } catch {
      return null;
    }
    const url = String(data.url ?? "");
    const token = String(data.token ?? "");
    const generation = String(data.generation ?? "");
    if (!url || !token || !generation) return null;
    const stale =
      JSON.stringify(data.sources ?? []) !== JSON.stringify(this.sourcesSig()) ||
      // A record written before model settings existed reads as model-free; it is stale when the
      // owner has model settings now (the daemon runs without them either way).
      JSON.stringify(data.model ?? []) !== JSON.stringify(this.modelSig());
    try {
      // Node's fetch never honors HTTP(S)_PROXY, so loopback cannot be routed through a refusing proxy.
      const res = await fetch(`${url}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.status !== 200) throw new Error(`healthz answered ${res.status}`);
    } catch {
      try {
        unlinkSync(share);
      } catch {
        // Gone already.
      }
      return null;
    }
    if (stale) {
      try {
        process.kill(Number(data.pid), "SIGTERM");
      } catch {
        // Already gone.
      }
      try {
        unlinkSync(share);
      } catch {
        // Gone already.
      }
      return null;
    }
    this.attached = true;
    this.generation = generation;
    this.endpointValue = { url, token, generation };
    return this.endpointValue;
  }

  /**
   * Serializes the attach-or-spawn section across owning processes: `<share>.lock` created O_EXCL with the
   * holder's pid. Without it two first owners both find no record, both spawn, and the loser's daemon is
   * orphaned — undiscoverable, holding a port (and the state dir's sqlite writes) forever. A stale lock
   * (dead holder, or unreadable) is removed and retried. Answers false after the spawn timeout, fail-open.
   */
  private async shareLock(): Promise<boolean> {
    const lock = `${this.options.sharePath}.lock`;
    try {
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    } catch {
      // mkdir raced another owner; a real failure surfaces as an EEXIST-less lock below.
    }
    const deadline = Date.now() + this.timeout;
    while (Date.now() < deadline) {
      try {
        writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        return true;
      } catch (e) {
        // Anything but EEXIST is not contention — an unwritable share path (EACCES, EROFS, ENOTDIR) would
        // otherwise take the stale path and spin its three failing syscalls for the whole spawn timeout,
        // blocking the event loop. Fail open instead, matching the Python client's `except Exception`.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          this.lockFailed = true;
          return false;
        }
        let stale = true;
        try {
          const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
          if (pid) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              // ESRCH is a dead holder; anything else (EPERM, a pid we cannot signal) is a live one.
              stale = (e as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
        } catch {
          // An unreadable or half-written lock is stale.
        }
        if (stale) {
          try {
            unlinkSync(lock);
          } catch {
            // Another contender already removed it.
          }
          continue;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return false;
  }

  /** Releases the share lock; never throws. */
  private shareUnlock(): void {
    try {
      unlinkSync(`${this.options.sharePath}.lock`);
    } catch {
      // A contender already reaped it as stale.
    }
  }

  /** The share file, atomically (tmp + rename), readable only by its owner. */
  private writeShare(): void {
    const share = this.options.sharePath;
    if (!share || !this.endpointValue || !this.process) return;
    try {
      mkdirSync(dirname(share), { recursive: true, mode: 0o700 });
      const tmp = `${share}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          url: this.endpointValue.url,
          token: this.endpointValue.token,
          pid: this.process.pid,
          generation: this.endpointValue.generation,
          sources: this.sourcesSig(),
          model: this.modelSig(),
        }),
        { mode: 0o600 },
      );
      chmodSync(tmp, 0o600);
      renameSync(tmp, share);
    } catch {
      // A share file that never lands costs a fresh spawn next process — fail open.
    }
  }

  private async spawnOnce(token: string): Promise<number | null> {
    // A .cmd/.bat shim is a command script, not an executable: on Windows it needs cmd.exe to run it.
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.command[0]!);
    const shared = this.options.sharePath !== undefined;
    let child: ChildProcess;
    try {
      // A detached server keeps no stderr pipe to drain: it appends to the log itself (EDEN_LOCAL_LOG).
      child = spawn(this.command[0]!, this.command.slice(1), {
        stdio: shared ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "pipe"],
        env: shared
          ? {
              ...this.childEnv(token),
              EDEN_LOCAL_DETACHED: "1",
              ...(this.options.logPath ? { EDEN_LOCAL_LOG: this.options.logPath } : {}),
              // The share file's directory is the daemon's durable home (D1994).
              EDEN_LOCAL_STATE_DIR: dirname(this.options.sharePath!),
            }
          : this.childEnv(token),
        detached: shared,
        ...(shim ? { shell: true } : {}),
      });
    } catch {
      return null; // an unspawnable command is the caller's "child did not become ready"
    }
    this.process = child;
    if (shared) {
      // The pipe ends when this process exits; nothing writes stdout after READY.
      child.unref();
    } else {
      this.pipeStderr(child);
    }
    return new Promise<number | null>((resolvePromise) => {
      let settled = false;
      const done = (port: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The detached server outlives us: drop our read end once the line came (or never will).
        if (shared) child.stdout?.destroy();
        resolvePromise(port);
      };
      const timer = setTimeout(() => done(null), this.timeout);
      let line = Buffer.alloc(0);
      let total = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > 65_536 || line.length > 1_024) return done(null);
        line = Buffer.concat([line, chunk]);
        const nl = line.indexOf(0x0a);
        if (nl < 0) return;
        const match = /^EDEN_LOCAL_READY ([0-9]{1,5})\r?$/.exec(line.subarray(0, nl).toString("utf8"));
        const port = match ? Number(match[1]) : null;
        done(port !== null && port >= 1 && port <= 65_535 ? port : null);
      });
      child.once("exit", () => done(null));
      child.once("error", () => done(null));
    });
  }

  /**
   * `(loopback URL, bearer token, generation)` or null; never throws. A live child answers at once; a dead or
   * missing one is spawned unless the backoff says wait — with `sharePath`, a live recorded daemon is
   * attached instead, so every process of the agent talks to the same Eden.
   */
  async endpoint(): Promise<{ url: string; token: string; generation: number | string } | null> {
    if (this.closed) return null;
    // Serialize startups: concurrent callers wait on the one spawn in flight.
    if (this.pending) {
      await this.pending.catch(() => undefined);
      return this.endpointValue;
    }
    // exitCode stays null when a signal killed the child; check signalCode too.
    const alive =
      this.process && this.process.exitCode === null && this.process.signalCode === null && !this.process.killed;
    if (alive && this.endpointValue) return this.endpointValue;
    // A child that died after answering is a failure like any other: it earns backoff before the next spawn.
    if (this.process && !alive) this.failure("child exited");
    if (this.attached) return this.endpointValue;
    const token = randomBytes(32).toString("base64url");
    const shared = this.options.sharePath !== undefined;
    this.pending = (async () => {
      // Cross-process attach-or-spawn is one locked section, or two first owners race and orphan a daemon.
      if (shared && !(await this.shareLock())) {
        this.failure(
          this.lockFailed
            ? "the shared daemon lock could not be created (check the share directory is writable)"
            : "the shared daemon lock was held through the spawn timeout",
        );
        return;
      }
      try {
        if (shared) {
          const attached = await this.attach().catch(() => null);
          if (attached) return; // a racing owner's record, or a live daemon
        }
        // The spawn backoff gates spawning only — a fresh record another owner wrote is still attached above.
        if (Date.now() < this.retryAt) return;
        this.startedAt = 0;
        const port = await this.spawnOnce(token);
        if (port === null || this.process?.exitCode !== null) {
          this.process?.kill("SIGKILL");
          this.failure("child did not become ready");
          return;
        }
        const count = (Number.parseInt(String(this.generation), 10) || 0) + 1;
        this.generation =
          // A shared daemon's generation must be unique across processes' restarts, or a long-lived
          // attacher's client cache would keep a replaced daemon's endpoint.
          shared ? `${count}:${randomBytes(8).toString("hex")}` : count;
        this.startedAt = Date.now();
        this.endpointValue = { url: `http://127.0.0.1:${port}`, token, generation: this.generation };
        this.writeShare();
      } finally {
        if (shared) this.shareUnlock();
      }
    })();
    await this.pending;
    this.pending = null;
    return this.endpointValue;
  }

  /** A failed connection prompts a poll, not termination of a live child. */
  failed(generation: number | string): void {
    // An attached daemon has no process to poll: the caller's "this generation's calls failed" is the signal
    // — drop the cached endpoint so the next endpoint() re-probes (or replaces) the recorded server.
    const dead =
      this.attached ||
      (this.process !== null &&
        (this.process.exitCode !== null || this.process.signalCode !== null || this.process.killed));
    if (generation === this.generation && dead) {
      this.endpointValue = null;
    }
    if (this.options.sharePath) this.attached = false; // the next endpoint() call re-probes the recorded server
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}

/** `eden-local` for an install: `EDEN_LOCAL_BINARY`, then `<pluginDir>/bin`, then each fallback dir's `bin/`. */
export function findLocalBinary(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  pluginDir?: string,
  fallbackDirs: string[] = [],
): string | null {
  const names = process.platform === "win32" ? ["eden-local.exe", "eden-local.cmd"] : ["eden-local"];
  const override = envOf(env, "EDEN_LOCAL_BINARY");
  if (override) return existsSync(override) ? resolve(override) : null;
  const candidates = [
    ...(pluginDir ? names.map((n) => join(pluginDir, "bin", n)) : []),
    ...fallbackDirs.flatMap((dir) => names.map((n) => join(dir, "bin", n))),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Where an agent's Eden lives: an explicit `EDEN_URL` (hosted, honoring `EDEN_API_KEY`/`EDEN_TENANT_ID`), else a
 * local binary + data dirs for `LocalEden`. Returns null when neither is configured; Eden registers nothing and
 * the agent runs on without it (D14).
 */
export function resolveLocalEden(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  opts: { pluginDir?: string; home: string; fallbackDirs?: string[]; warn?: (problem: string) => void },
): { baseUrl: string; apiKey?: string; tenantId?: string; userId: string } | { binary: string; home: string } | null {
  const warn = (p: string) => {
    try {
      opts.warn?.(p);
    } catch {
      // A dead logger must not kill the plugin.
    }
  };
  const baseUrl = envOf(env, "EDEN_URL");
  if (baseUrl) {
    return {
      baseUrl,
      apiKey: envOf(env, "EDEN_API_KEY"),
      tenantId: envOf(env, "EDEN_TENANT_ID"),
      userId: envOf(env, "EDEN_USER_ID") ?? "local",
    };
  }
  if (envOf(env, "EDEN_API_KEY") || envOf(env, "EDEN_TENANT_ID")) {
    warn("local mode ignores EDEN_API_KEY and EDEN_TENANT_ID");
  }
  const binary = findLocalBinary(env, opts.pluginDir, [
    join(opts.home, "plugins", "eden"),
    ...(opts.fallbackDirs ?? []),
  ]);
  if (binary === null) {
    warn("local binary not found; Eden registers nothing");
    return null;
  }
  return { binary, home: opts.home };
}
