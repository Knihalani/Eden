import { wrapFetch } from "@/lib/wrap";
import { PRIVATE_NO_STORE } from "@/lib/http-cache";

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

function run(req: Request) {
  return wrapFetch()(req).then(seal);
}

export const GET = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;
export const HEAD = run;
export const OPTIONS = run;
