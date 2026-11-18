import { timingSafeEqual } from "node:crypto";
import { DEFAULT_MAX_BODY_BYTES, type ServerConfig } from "./config";
import { keyOf } from "./auth";

const ALLOWED = new Set(["EDEN_LOCAL", "EDEN_LOCAL_TOKEN", "EDEN_SOURCES_FILE", "EDEN_USER_SOURCES_FILE"]);

export function localConfig(env = process.env): ServerConfig | null {
  const mode = env.EDEN_LOCAL;
  if (!mode) return null;
  if (mode !== "1") throw new Error("EDEN_LOCAL must be 1 or unset");
  console.log = console.info = (...args: unknown[]) => console.error(...args);
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
    persist: null,
    sourceMapPath: ":memory:",
    queryPlanner: "serve",
    tenantRatePerSec: 200,
    tenantBurst: 400,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    shutdownGraceMs: 1000,
  };
}

export function localBoundary(
  handler: (req: Request) => Response | Promise<Response>,
  port: () => number,
  token: string,
): (req: Request) => Response | Promise<Response> {
  const expected = Buffer.from(token);
  return (req) => {
    const host = req.headers.get("host");
    if (req.headers.has("origin") || (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (new URL(req.url).pathname === "/metrics") {
      const key = Buffer.from(keyOf(req));
      if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }
    return handler(req);
  };
}

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
