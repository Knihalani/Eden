import { respondToHook, type HookIn } from "./hook";

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
 * Rejecting on either is enough to close the drive-by path without needing a
 * shared secret the hook command would have to carry.
 */
function looksBrowserDriven(req: Request): boolean {
  if (req.headers.get("origin")) return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "none";
}

export async function handleHookd(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "eden-hookd" });
  }
  if (req.method !== "POST") {
    return Response.json({});
  }
  if (looksBrowserDriven(req)) {
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
  try {
    const out = await Promise.race([
      Promise.resolve(respondToHook(input)),
      new Promise<Record<string, never>>((_, reject) => {
        const t = setTimeout(() => reject(new Error("hookd timeout")), hookdTimeoutMs());
        t.unref?.();
      }),
    ]);
    return Response.json(out);
  } catch {
    return Response.json({});
  }
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
  await new Promise(() => undefined);
}

if (import.meta.main) await runHookd();
