/**
 * Workspace mode helpers — personal vs team gates (Wave 1.5).
 *
 * Soft-hide team chrome when ``Organization.is_personal``; product copy
 * always uses “workspace” (not “organization”).
 */

export type WorkspaceOrgLike =
  | { is_personal?: boolean }
  | null
  | undefined;

export function isPersonalWorkspace(org: WorkspaceOrgLike): boolean {
  return Boolean(org?.is_personal);
}

/** Product copy: always “workspace” in user-facing strings. */
export function workspaceNoun(_org?: WorkspaceOrgLike): "workspace" {
  return "workspace";
}

export function canUseTeamFeatures(org: WorkspaceOrgLike): boolean {
  return !isPersonalWorkspace(org);
}

/** Settings tab ids that require a team workspace (SCIM). */
export const teamOnlyTabs = ["scim"] as const;

const TEAM_ONLY_TAB_SET: ReadonlySet<string> = new Set(teamOnlyTabs);

export function isTeamOnlyTab(tabId: string): boolean {
  return TEAM_ONLY_TAB_SET.has(tabId);
}

/** Invite teammates — team workspaces only (not a tab id). */
export function canInviteMembers(org: WorkspaceOrgLike): boolean {
  return canUseTeamFeatures(org);
}

/** Ownership transfer — team workspaces only (not a tab id). */
export function canTransferOwnership(org: WorkspaceOrgLike): boolean {
  return canUseTeamFeatures(org);
}

export const WS1_WORKSPACE_MODE_COMPLETED = true as const;
