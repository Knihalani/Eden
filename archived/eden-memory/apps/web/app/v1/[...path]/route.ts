import { wrapFetch } from "@/lib/wrap";
import { PRIVATE_NO_STORE } from "@/lib/http-cache";
import { v1Authorized } from "../auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const fetchCache = "default-no-store";
export const runtime = "nodejs";

function seal(res: Response): Response {
  if (res.headers.get("cache-control")) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", PRIVATE_NO_STORE);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const unauthorized = () =>
  Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": PRIVATE_NO_STORE } });

function run(req: Request) {
  // OPTIONS carries no authorization header by spec — the handler answers
  // CORS preflights itself. Everything else must present a credential that is
  // valid for this install (see ./auth.ts for why this sits in front of the
  // embedded handler's own gate).
  if (req.method !== "OPTIONS" && !v1Authorized(req)) return unauthorized();
  return wrapFetch()(req).then(seal);
}

export const GET = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;
export const HEAD = run;
export const OPTIONS = run;
