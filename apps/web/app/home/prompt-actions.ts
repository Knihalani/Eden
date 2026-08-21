"use server";

import { auth } from "@clerk/nextjs/server";
import { SEE_PENDING } from "../account/home";
import { PLACEHOLDER_ENV, type PromptEnv } from "./prompt-text";
import { promptValues } from "./values";

/** Mint and return real env only after an explicit “with keys” action. */
export async function filledPrompt(): Promise<PromptEnv> {
  const { userId, orgId, sessionStatus } = await auth(SEE_PENDING);
  if (!userId || sessionStatus === "pending" || !orgId) return PLACEHOLDER_ENV;
  const { filled } = await promptValues(orgId);
  return filled;
}
