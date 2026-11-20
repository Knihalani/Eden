/**
 * Fail-open owner of one local Eden process, the TypeScript port of `eden_client/local.py`: personal-agent
 * integrations written in TS/JS (Pi extensions, OpenClaw plugins, …) get the same local mode Hermes's plugin gets —
 * a bundled `eden-local` binary beside the plugin, spawned on demand, talked to over loopback with a fresh bearer
 * token. The caller owns registration of `close` at exit; nothing here throws to its caller.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
  closeSync,
  readFileSync,
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
  /** The environment the child filters down from (default `process.env`). */
  env?: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  /** For the caller's log lines; defaults to `console.error`-style stderr writes. */
  warn?: (problem: string) => void;
}

/** One endpoint per generation; a dead child is restarted lazily on the next `endpoint()` with backoff. */
export class LocalEden {
  private process: ChildProcess | null = null;
  private endpointValue: { url: string; token: string; generation: number } | null = null;
  private generation = 0;
  private closed = false;
  private retryAt = 0;
  private backoff = 1;
  private startedAt = 0;
  private pending: Promise<unknown> | null = null;
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
    if (!child) return;
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

  private async spawnOnce(token: string): Promise<number | null> {
    // A .cmd/.bat shim is a command script, not an executable: on Windows it needs cmd.exe to run it.
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.command[0]!);
    let child: ChildProcess;
    try {
      child = spawn(this.command[0]!, this.command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.childEnv(token),
        ...(shim ? { shell: true } : {}),
      });
    } catch {
      return null; // an unspawnable command is the caller's "child did not become ready"
    }
    this.process = child;
    this.pipeStderr(child);
    return new Promise<number | null>((resolvePromise) => {
      let settled = false;
      const done = (port: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
   * missing one is spawned unless the backoff says wait.
   */
  async endpoint(): Promise<{ url: string; token: string; generation: number } | null> {
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
    if (Date.now() < this.retryAt) return null;
    const token = randomBytes(32).toString("base64url");
    this.pending = (async () => {
      this.startedAt = 0;
      const port = await this.spawnOnce(token);
      if (port === null || this.process?.exitCode !== null) {
        this.process?.kill("SIGKILL");
        this.failure("child did not become ready");
        return;
      }
      this.generation += 1;
      this.startedAt = Date.now();
      this.endpointValue = { url: `http://127.0.0.1:${port}`, token, generation: this.generation };
    })();
    await this.pending;
    this.pending = null;
    return this.endpointValue;
  }

  /** A failed connection prompts a poll, not termination of a live child. */
  failed(generation: number): void {
    const dead =
      this.process && (this.process.exitCode !== null || this.process.signalCode !== null || this.process.killed);
    if (generation === this.generation && dead) {
      this.endpointValue = null;
    }
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
