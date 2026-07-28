/**
 * Marketing auth detection without mounting ClerkProvider on public pages.
 * Uses the request session via Clerk middleware + ``auth()``.
 *
 * Wrapped in ``React.cache`` so header/hero/sections/footer share one
 * ``auth()`` lookup per request instead of three–four serial Clerk hits.
 */

import { cache } from "react";
import { auth } from "@clerk/nextjs/server";

export {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-cta";

export const isMarketingSignedIn = cache(async (): Promise<boolean> => {
  try {
    const { userId } = await auth();
    return Boolean(userId);
  } catch {
    return false;
  }
});
