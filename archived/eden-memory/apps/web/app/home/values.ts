import { headers } from "next/headers";
import { edenKey } from "../lib/eden-key";
import { PLACEHOLDER_ENV, type PromptEnv } from "./prompt-text";

export async function promptValues(orgId: string): Promise<{ placeholders: PromptEnv; filled: PromptEnv }> {
  const hostHeaders = await headers();
  const host = hostHeaders.get("x-forwarded-host") || hostHeaders.get("host") || "localhost:8788";
  const proto = hostHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const url = `${proto}://${host}`;

  // Same secret wrap actually accepts. On a managed install with no
  // EDEN_API_KEY configured we keep the placeholders rather than presenting a
  // publicly-known credential; the "with keys" action will bind the org and
  // the control plane refuses unbound writes anyway.
  let key = PLACEHOLDER_ENV.key;
  try {
    key = edenKey();
  } catch {
    /* managed deploy without EDEN_API_KEY: show placeholders, not eden_dev */
  }

  return {
    placeholders: PLACEHOLDER_ENV,
    filled: {
      org: orgId,
      key,
      url,
    },
  };
}
