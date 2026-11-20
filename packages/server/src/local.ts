/**
 * Hermes' private local sidecar: volatile state avoids independent CLI/gateway processes racing persistent files.
 * Reads only EDEN_LOCAL, EDEN_LOCAL_TOKEN, EDEN_SOURCES_FILE and EDEN_USER_SOURCES_FILE;
 * other Eden/model env is scrubbed.
 */
import { Console } from "node:console";
import { timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_BODY_BYTES, type ServerConfig } from "./config";
import { keyOf } from "./auth";

const ALLOWED = new Set([
  "EDEN_LOCAL",
  "EDEN_LOCAL_TOKEN",
  "EDEN_LOCAL_DETACHED",
  "EDEN_LOCAL_LOG",
  "EDEN_SOURCES_FILE",
  "EDEN_USER_SOURCES_FILE",
]);

/** The detached daemon's stderr cap: the file is renamed to `.1` past it, once per start (as the client's cap). */
const LOCAL_LOG_CAP = 1024 * 1024;

/**
 * Keeps stdout reserved for the owner's readiness protocol, including diagnostic console methods. With
 * EDEN_LOCAL_LOG set (a detached daemon, whose owner cannot drain its stderr), writes go to that file instead.
 */
export function redirectLocalConsole(env = process.env): void {
  let target: { stdout: WriteStream | NodeJS.WriteStream; stderr: WriteStream | NodeJS.WriteStream } = {
    stdout: process.stderr,
    stderr: process.stderr,
  };
  const logPath = env.EDEN_LOCAL_LOG;
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      if (existsSync(logPath) && statSync(logPath).size > LOCAL_LOG_CAP) renameSync(logPath, `${logPath}.1`);
      const stream = createWriteStream(logPath, { flags: "a" });
      target = { stdout: stream, stderr: stream };
    } catch {
      // An unwritable log keeps stderr; the daemon runs either way.
    }
  }
  const stderr = new Console(target);
  for (const method of [
    "log",
    "info",
    "debug",
    "trace",
    "dir",
    "dirxml",
    "table",
    "count",
    "countReset",
    "time",
    "timeLog",
    "timeEnd",
    "group",
    "groupCollapsed",
    "groupEnd",
    "assert",
    "clear",
  ] as const) {
    Object.assign(console, { [method]: stderr[method].bind(stderr) });
  }
  console.write = (...data) => {
    let written = 0;
    for (const part of data) {
      const bytes =
        typeof part === "string"
          ? Buffer.from(part)
          : ArrayBuffer.isView(part)
            ? Buffer.from(part.buffer, part.byteOffset, part.byteLength)
            : Buffer.from(part);
      process.stderr.write(bytes);
      written += bytes.byteLength;
    }
    return written;
  };
}

/** Validates local activation and consumes its token after removing inherited Eden/model capabilities. */
export function localConfig(env = process.env): ServerConfig | null {
  const mode = env.EDEN_LOCAL;
  if (!mode) return null;
  if (mode !== "1") throw new Error("EDEN_LOCAL must be 1 or unset");
  const ignored: string[] = [];
  for (const name of Object.keys(env)) {
    if ((name.startsWith("EDEN_") && !ALLOWED.has(name)) || /^(OPENROUTER_|ANTHROPIC_|HAIKU_)/.test(name)) {
      if (name.startsWith("EDEN_")) ignored.push(name);
      delete env[name];
    }
  }
  if (ignored.length) console.error(`eden: local mode ignored ${ignored.sort().join(", ")}`);
  const token = env.EDEN_LOCAL_TOKEN ?? "";
  delete env.EDEN_LOCAL_TOKEN;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("EDEN_LOCAL_TOKEN must be 32-256 URL-safe characters");
  }
  return {
    keys: new Map([[token, "local"]]),
    dev: false,
    host: "127.0.0.1",
    port: 0,
    processes: 1,
    child: null,
    gateWorkers: 0,
    // EDEN_LOCAL_DETACHED=1: the owner (a shared LocalEden) detaches the server so it outlives every
    // short-lived hook/CLI process; stdin carries no lifetime meaning and is closed.
    detached: env.EDEN_LOCAL_DETACHED === "1" ? true : undefined,
    persist: null,
    sourceMapPath: ":memory:",
    queryPlanner: "serve",
    tenantRatePerSec: 200,
    tenantBurst: 400,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    shutdownGraceMs: 1000,
  };
}

/** Fences every local request before ops routes, and protects metrics with the owner's bearer token. */
export function localBoundary(
  handler: (req: Request) => Response | Promise<Response>,
  port: () => number,
  token: string,
): (req: Request) => Response | Promise<Response> {
  const expected = Buffer.from(token);
  return (req) => {
    const host = req.headers.get("host");
    if (req.headers.has("origin") || (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`)) {
      return Response.json({ error: "local mode serves only this machine's Host, with no Origin" }, { status: 403 });
    }
    if (new URL(req.url).pathname === "/metrics") {
      const key = Buffer.from(keyOf(req));
      if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
        return Response.json({ error: "missing or unknown API key" }, { status: 401 });
      }
    }
    return handler(req);
  };
}

/** Treats EOF or an error on the owner's lifetime pipe as a clean shutdown. */
export async function watchLocalInput(shutdown: () => Promise<void>): Promise<void> {
  try {
    for await (const _ of Bun.stdin.stream()) {
      /* Only EOF carries meaning. */
    }
  } catch {
    // A broken lifetime pipe means the owner is gone too.
  }
  await shutdown();
}
