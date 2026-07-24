/**
 * Marketing auth detection without mounting ClerkProvider on public pages.
 * Uses the request session via Clerk middleware + ``auth()``.
 */

import { auth } from "@clerk/nextjs/server";

export {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";

export async function isMarketingSignedIn(): Promise<boolean> {
  try {
    const { userId } = await auth();
    return Boolean(userId);
  } catch {
    return false;
  }
}
