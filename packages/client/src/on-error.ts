/**
 * The `onError` a client uses when the integrator sets none (D850).
 *
 * Before D850 an unset `onError` swallowed everything, so a refused key, a bad id or a server on another port looked
 * exactly like Eden's normal silence (weak point D4 of docs/research/weak-points-1111.md). The default now says so:
 *
 * - **Development** (the default; `EDEN_ENV`, else `NODE_ENV`, is not `production`): every distinct problem is
 *   printed once with `console.warn`, followed by the fix. Loud enough to see on the first run, never a throw (D14).
 * - **Production** (`EDEN_ENV`/`NODE_ENV` is `production`): only the first problem of each kind (route and status)
 *   is printed, once per process, so a deploy with a wrong key still leaves one line in the logs and a flapping
 *   network cannot flood them. Calls still fail open.
 *
 * `onError: null` silences it; any function replaces it. The line carries the client's own error text (route,
 * status, the server's reason, redacted URLs), never the request, an id or the key.
 */

/**
 * The process's environment, or undefined where there is none (a browser bundle, an edge worker without Node
 * compatibility): the client's constructor must never throw (D14; the review of D850).
 */
function processEnv(): Record<string, string | undefined> | undefined {
  try {
    return typeof process === "undefined" ? undefined : process.env;
  } catch {
    return undefined;
  }
}

/** Which of the two behaviours a client runs, from `EDEN_ENV`, then `NODE_ENV`. */
export type EdenEnv = "development" | "production";

export function edenEnv(env: Record<string, string | undefined> | undefined = processEnv()): EdenEnv {
  const v = (env?.EDEN_ENV ?? env?.NODE_ENV ?? "").trim().toLowerCase();
  return v === "production" || v === "prod" ? "production" : "development";
}

/**
 * The fix for a client error, keyed on the text the client writes (`eden <route>: <status> <reason>` or
 * `eden <route>: cannot reach <url> (<why>)`). Null when there is no specific advice.
 */
export function fixFor(message: string): string | null {
  if (/must be 1-128 characters/.test(message)) {
    return "map user and session ids with edenId(raw) (Python: eden_id) before passing them; the same mapping everywhere";
  }
  if (/cannot reach/.test(message)) {
    return "start the server (bun run dev, or the Docker image) and check baseUrl (default http://127.0.0.1:8790)";
  }
  if (/: 401\b/.test(message)) {
    return "the server refused the key: pass apiKey (one of EDEN_API_KEYS on the server), or omit it against EDEN_DEV=1";
  }
  if (/: 403\b/.test(message)) return "the key belongs to another tenant: drop tenantId or use that tenant's key";
  if (/: 404\b/.test(message)) return "baseUrl should be the server's root (no /v1 suffix); upgrade an older server";
  if (/: 413\b/.test(message)) return "the event is too large: send the text the agent saw, not whole attachments";
  if (/: 429\b/.test(message)) return "the tenant's rate cap was hit; Eden stays silent until it frees";
  if (/: 400\b/.test(message)) return "the server refused the request's shape; the reason above names the field";
  if (/: 5\d\d\b/.test(message))
    return "the server failed internally; its log has the cause (the agent was not affected)";
  if (/not an? \w+ answer|unreadable answer/.test(message)) {
    return "something other than Eden answered at baseUrl (a proxy or another service on that port)";
  }
  return null;
}

/** The kind a production default de-duplicates on: the route and status, not the reason's free text. */
function kindOf(message: string): string {
  const m = /^eden (\S+?):? (\d{3}|cannot reach|not an? \w+|an unreadable)/.exec(message);
  return m ? `${m[1]} ${m[2]}` : message.slice(0, 80);
}

/** Problems already printed in this process: one per text in development, one per kind in production. */
const printed = new Set<string>();
/** Bound on `printed`, so a process with many distinct errors keeps a fixed footprint. */
const MAX_PRINTED = 256;

/** Clears what the default has printed (tests). */
export function resetDefaultOnError(): void {
  printed.clear();
}

/**
 * The default `onError` for the given environment. `warn` defaults to `console.warn`; a test passes its own.
 */
export function defaultOnError(
  env: EdenEnv = edenEnv(),
  warn: (line: string) => void = (line) => console.warn(line),
): (error: unknown) => void {
  return (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const key = env === "production" ? `p:${kindOf(message)}` : `d:${message}`;
    if (printed.has(key) || printed.size >= MAX_PRINTED) return;
    printed.add(key);
    const fix = fixFor(message);
    const tail =
      env === "production"
        ? " (Eden failed open; further errors of this kind are not printed. Set onError to log them.)"
        : " (Eden failed open: the agent got no context. Set onError to handle errors yourself, or null to silence.)";
    warn(`${message}${tail}${fix ? `\n  fix: ${fix}` : ""}`);
  };
}
