/**
 * Marketing auth detection without mounting ClerkProvider on public pages.
 * Uses the request session via Clerk middleware + ``auth()``.
 */

import { auth } from "@clerk/nextjs/server";

/** Product entry for signed-in visitors on marketing surfaces. */
export const MARKETING_APP_HREF = "/home";
export const MARKETING_APP_LABEL = "Go to Eden";

export async function isMarketingSignedIn(): Promise<boolean> {
  try {
    const { userId } = await auth();
    return Boolean(userId);
  } catch {
    return false;
  }
}
