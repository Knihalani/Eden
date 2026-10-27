import { wrapFetch } from "@/lib/wrap";
import { PRIVATE_NO_STORE } from "@/lib/http-cache";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const fetchCache = "default-no-store";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const res = await wrapFetch()(req);
  if (res.headers.get("cache-control")) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", PRIVATE_NO_STORE);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
