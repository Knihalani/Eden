import { wrapFetch } from "@/lib/wrap";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return wrapFetch()(req);
}
