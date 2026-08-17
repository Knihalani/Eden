import { handleFetch } from "../../server";

/** Frozen workshop plane (8787). Product UI is apps/web. */

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function run(req: Request) {
  return handleFetch(req);
}

export const GET = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;
export const HEAD = run;
export const OPTIONS = run;
