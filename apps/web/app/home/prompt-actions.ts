"use server";

import { auth } from "@clerk/nextjs/server";
import { SEE_PENDING } from "../account/home";
import { bindWorkspaceOrg } from "../canvas/actions";
import { PLACEHOLDER_ENV, type PromptEnv } from "./prompt-text";
import { promptValues } from "./values";

/** Mint and return real env only after an explicit “with keys” action. */
export async function filledPrompt(): Promise<PromptEnv> {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId || sessionStatus === "pending" || !orgId) return PLACEHOLDER_ENV;
  // Provisioning moment: connect this org to the workspace so its approve /
  // pause / dismiss calls pass the control plane's tenant gate. Best-effort —
  // a refusal here surfaces later as a clear 403 on the first state change.
  const bound = await bindWorkspaceOrg();
  if (!bound.ok) console.error(`[eden] workspace binding for ${orgId} failed: ${bound.error}`);
  const { filled } = await promptValues(orgId);
  return filled;
}
