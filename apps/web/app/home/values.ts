import { clerkClient } from "@clerk/nextjs/server";
import { randomBytes } from "node:crypto";
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
      key: await workspaceKey(orgId),
      url,
    },
  };
}

async function workspaceKey(orgId: string) {
  try {
    const clerk = await clerkClient();
    const org = await clerk.organizations.getOrganization({ organizationId: orgId });
    const existing = org.privateMetadata?.edenApiKey;
    if (typeof existing === "string" && existing) return existing;
    const key = `eden_${randomBytes(18).toString("base64url")}`;
    await clerk.organizations.updateOrganizationMetadata(orgId, {
      privateMetadata: { edenApiKey: key },
    });
    return key;
  } catch {
    return PLACEHOLDER_ENV.key;
  }
}
