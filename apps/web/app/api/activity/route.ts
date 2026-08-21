import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { SEE_PENDING } from "../../account/home";
import { EMPTY_ACTIVITY } from "../../home/activity";
import { loadActivity } from "../../home/load-activity";
import { noneMatch, PRIVATE_NO_CACHE, weakEtag } from "@/lib/http-cache";

export const dynamic = "force-dynamic";
export const fetchCache = "default-no-store";

export async function GET(req: Request) {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId || sessionStatus !== "active" || !orgId) {
    return NextResponse.json(EMPTY_ACTIVITY, {
      status: 401,
      headers: { "cache-control": PRIVATE_NO_CACHE },
    });
  }
  const body = JSON.stringify(await loadActivity());
  const etag = weakEtag(body);
  if (noneMatch(req, etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: { etag, "cache-control": PRIVATE_NO_CACHE },
    });
  }
  return new NextResponse(body, {
    headers: {
      etag,
      "content-type": "application/json",
      "cache-control": PRIVATE_NO_CACHE,
    },
  });
}
