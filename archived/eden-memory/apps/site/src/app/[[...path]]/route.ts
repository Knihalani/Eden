import { handleFetch } from "../../server";

/**
 * Frozen workshop plane (8787).
 *
 * maxDuration 60 keeps this deployable on every plan tier and bounds what a
 * hung upstream costs. Trace compiles are sub-second at realistic sizes; if
 * a compile ever legitimately needs longer, raise it deliberately.
 */
export const maxDuration = 60;
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
