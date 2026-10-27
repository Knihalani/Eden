import { timingSafeEqual } from "node:crypto";
import { edenKey } from "@/app/lib/eden-key";

/**
 * Bearer gate for the /v1 catch-all.
 *
 * The embedded control handler is constructed with
 * `EDEN_API_KEY || "eden_dev"` (lib/wrap.ts) and Next middleware exempts /v1
 * from Clerk, so without this check a managed deployment with no key
 * configured would accept `Bearer eden_dev` — a credential that is public —
 * from the internet: full read of all workspaces, plus writes on ungated
 * routes. edenKey() throws exactly where the dev fallback must not exist
 * (managed install, EDEN_DEV !== 1); every such request gets a 401 instead of
 * ever reaching the handler.
 */
export function v1Authorized(req: Request): boolean {
  let key: string;
  try {
    key = edenKey();
  } catch (err) {
    console.error(`[eden] /v1 unavailable: ${(err as Error).message}`);
    return false;
  }
  const m = /^Bearer\s+(.*)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return false;
  const got = Buffer.from(m[1], "utf8");
  const want = Buffer.from(key, "utf8");
  // Compare without letting the response time reveal a prefix match.
  return got.length === want.length && timingSafeEqual(got, want);
}
