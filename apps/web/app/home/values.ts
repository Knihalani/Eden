import { headers } from "next/headers";
import { PLACEHOLDER_ENV, type PromptEnv } from "./prompt-text";

export async function promptValues(orgId: string): Promise<{ placeholders: PromptEnv; filled: PromptEnv }> {
  const hostHeaders = await headers();
  const host = hostHeaders.get("x-forwarded-host") || hostHeaders.get("host") || "localhost:8788";
  const proto = hostHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const url = `${proto}://${host}`;

  return {
    placeholders: PLACEHOLDER_ENV,
    filled: {
      org: orgId,
      // Same secret wrap actually accepts. A second minted org key 401s and
      // Home stays at honest zeros after "with keys".
      key: process.env.EDEN_API_KEY || "eden_dev",
      url,
    },
  };
}
