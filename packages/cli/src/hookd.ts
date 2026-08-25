import { respondToHook, type HookIn } from "./hook";
import { withFileLockAsync } from "./home";

export function hookdTimeoutMs(): number {
  const n = Number(process.env.EDEN_HOOKD_TIMEOUT_MS || 8000);
  return Number.isFinite(n) ? Math.min(60_000, Math.max(500, n)) : 8000;
}

/**
 * Refuses requests a browser could have made on the user's behalf.
 *
 * hookd listens on loopback with no credential, which is fine for the CLI but
 * not for the web: a POST with `content-type: text/plain` is a CORS *simple*
 * request, so any page the user visits can drive this endpoint with no
 * preflight and no consent. Bun's req.json() parses regardless of content type,
 * so the wrong content type was not a barrier either.
 *
 * The hook is a local, machine-to-machine caller, so it never carries Origin.
 * A browser always does, and Sec-Fetch-Mode marks the request as cross-site.
 * Rejecting on either closes the ordinary drive-by path without needing a
 * shared secret the hook command would have to carry.
 *
 * Neither of those signals survives DNS rebinding, though, because both are
 * relative to an origin the attacker now controls the name of. A page on
 * http://evil.test:8794 whose hostname re-resolves to 127.0.0.1 is, as far as
 * the browser is concerned, talking to itself: it sends no Origin and
 * `Sec-Fetch-Site: same-origin`, and both checks above pass. The one header
 * that still tells the truth is Host, which carries the name the client
 * *asked* for rather than the address it reached — and a genuine local caller
 * asks for 127.0.0.1 or localhost.
 */
function looksBrowserDriven(req: Request): boolean {
  if (req.headers.get("origin")) return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "none";
}

/** The names a caller that really means "this machine" will have used. */
function hostIsLoopback(req: Request): boolean {
  const raw = req.headers.get("host");
  // No Host at all is HTTP/1.0 or a raw socket, not a browser; a browser
  // always sends one. Bun also fills req.url from it, so absence is benign.
  if (!raw) return true;
  const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export async function handleHookd(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "eden-hookd" });
  }
  if (req.method !== "POST") {
    return Response.json({});
  }
  if (looksBrowserDriven(req) || !hostIsLoopback(req)) {
    return Response.json({}, { status: 403 });
  }
  // Only the hook endpoint accepts a payload. Anything else is a caller that
  // has the wrong idea about this server, and answering it invites confusion.
  if (path !== "/hook" && path !== "/") {
    return Response.json({}, { status: 404 });
  }
  let input: HookIn = {};
  try {
    input = (await req.json()) as HookIn;
  } catch {
    return Response.json({});
  }
  // Serialized, not raced-then-abandoned: the old Promise.race returned to the
  // client on timeout while the losing respondToHook KEPT RUNNING holding the
  // session-file lock, so every hook during that window contended for up to
  // LOCK_WAIT_MS and then failed open — recording silently lost under load.
  // A queue bounds total latency (timeout per request) and makes lock
  // contention structurally impossible.
  const done = enqueue(input);
  try {
    const out = await done;
    return Response.json(out);
  } catch (err) {
    // Same last-line-of-defence contract as `eden hook`: `{}` never blocks the
    // agent — but the failure must still reach the operator's log.
    process.stderr.write(`eden hookd: ${(err as Error)?.message ?? String(err)}\n`);
    return Response.json({});
  }
}

/** Serializes /hook handling; each entry is bounded by hookdTimeoutMs. */
let tail: Promise<unknown> = Promise.resolve();
function enqueue(input: HookIn): Promise<Record<string, unknown>> {
  const job = tail.then(
    () => Promise.race([
      Promise.resolve(respondToHook(input, withFileLockAsync)),
      new Promise<Record<string, never>>((_, reject) => {
        const t = setTimeout(() => reject(new Error("hookd timeout")), hookdTimeoutMs());
        t.unref?.();
      }),
    ]),
    // A previous failure must not poison the chain.
    () =>
      Promise.race([
        Promise.resolve(respondToHook(input, withFileLockAsync)),
        new Promise<Record<string, never>>((_, reject) => {
          const t = setTimeout(() => reject(new Error("hookd timeout")), hookdTimeoutMs());
          t.unref?.();
        }),
      ]),
  );
  // Keep the chain alive regardless of this job's outcome.
  tail = job.catch(() => undefined);
  return job;
}

export async function runHookd(): Promise<void> {
  const port = Number(process.env.EDEN_HOOKD_PORT || 8794);
  const hostname = process.env.EDEN_HOOKD_HOST || "127.0.0.1";
  const server = Bun.serve({
    port,
    hostname,
    fetch: handleHookd,
  });
  console.error(`eden hookd ${server.url}`);
  // Graceful shutdown: stop accepting, let the in-flight queue drain (each
  // entry bounded by its own timeout), then exit 0. SIGKILL remains the
  // user's escape hatch; stale-lock detection covers it.
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.stop(false); // stop accepting new connections
    void tail.then(() => process.exit(0));
    // If draining somehow wedges, the unref'd timers below still let the
    // process die naturally rather than hanging forever.
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => undefined);
}

if (import.meta.main) await runHookd();
