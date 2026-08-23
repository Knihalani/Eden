"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";

export async function inviteToWorkspace(emailAddress: string) {
  const email = emailAddress.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { error: "Enter an email to invite." };
  }

  const { userId, orgId, has } = await auth();
  if (!userId) return { error: "Sign in to invite." };
  if (!orgId) return { error: "Create a workspace first." };
  if (!has({ role: "org:admin" })) {
    return { error: "You can’t invite to this workspace." };
  }

  const hostHeaders = await headers();
  const host = hostHeaders.get("x-forwarded-host") || hostHeaders.get("host");
  const proto = hostHeaders.get("x-forwarded-proto") || "http";
  const redirectUrl = host ? `${proto}://${host}/workspace` : undefined;

  try {
    const clerk = await clerkClient();
    await clerk.organizations.createOrganizationInvitation({
      organizationId: orgId,
      inviterUserId: userId,
      emailAddress: email,
      role: "org:member",
      redirectUrl,
    });
    return { error: null };
  } catch {
    return { error: "Couldn’t send that invite. Try again." };
  }
}
