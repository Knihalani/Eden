"use client";

import { useOrg } from "@/hooks/use-org";
import {
  canInviteMembers,
  canTransferOwnership,
  canUseTeamFeatures,
  isPersonalWorkspace,
  workspaceNoun,
} from "@/lib/workspace-mode";

/**
 * Thin org-aware wrapper around ``@/lib/workspace-mode`` helpers.
 */
export function useWorkspaceMode() {
  const { currentOrg } = useOrg();
  return {
    org: currentOrg,
    isPersonal: isPersonalWorkspace(currentOrg),
    canUseTeamFeatures: canUseTeamFeatures(currentOrg),
    workspaceNoun: workspaceNoun(currentOrg),
    canInviteMembers: canInviteMembers(currentOrg),
    canTransferOwnership: canTransferOwnership(currentOrg),
  };
}
