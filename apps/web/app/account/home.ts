import { toolsListTitle } from "@eden/ir";

export const LANDING = "/";
export const HOME = "/home";
export const SETUP = "/setup";
export const TOUR = "/tour";
export const WORKSPACE = "/workspace";
export const SSO_CALLBACK = "/sso-callback";
export const SEE_PENDING = { treatPendingAsSignedOut: false } as const;

export type HomeView = "overview" | "requests" | "workflows";

export function parseHomeView(raw: string | null | undefined): HomeView {
  if (raw === "requests" || raw === "workflows") return raw;
  return "overview";
}

export function homePath(view: HomeView = "overview") {
  if (view === "overview") return HOME;
  return `${HOME}?view=${view}`;
}

export function homeViewTitle(view: HomeView, serving?: { canary: number; live: number }) {
  if (view === "requests") return "Requests";
  if (view === "workflows") return toolsListTitle(serving ?? { canary: 0, live: 0 });
  return "Home";
}

/** Canvas back-link. Live with nothing to count is `0 programs`, not Live tools. */
export function canvasBackTitle(model: {
  mode: "request" | "live";
  rollout?: "canary" | "live" | null;
  program?: unknown;
}) {
  if (model.mode !== "live") return "Requests";
  const canary = model.rollout === "canary" ? 1 : 0;
  const counted = Boolean(model.program) || model.rollout === "live";
  const live = canary ? 0 : counted ? 1 : 0;
  return toolsListTitle({ canary, live });
}

export function homeStatus(activity: { requests?: unknown[]; workflows?: unknown[] }) {
  const requests = Array.isArray(activity.requests) ? activity.requests.length : 0;
  const workflows = Array.isArray(activity.workflows) ? activity.workflows.length : 0;
  if (requests > 0) return requests === 1 ? "1 request waiting" : `${requests} requests waiting`;
  if (workflows > 0) return workflows === 1 ? "1 workflow" : `${workflows} workflows`;
  return "Empty until you wrap";
}

export function homeEmptyLine(view: HomeView, failed = false) {
  if (failed) return "Couldn’t load activity.";
  if (view === "requests") return "Nothing waiting. If nothing compiled: eden explain.";
  if (view === "workflows") return "0 programs. Approve a request and it shows up here.";
  return "Requests land here after you wrap. Empty is 0 programs.";
}

export function navCurrent(path: string, view: HomeView = "overview"): HomeView | "setup" | "tour" | null {
  if (path === TOUR || path.startsWith(`${TOUR}/`)) return "tour";
  if (path === SETUP || path.startsWith(`${SETUP}/`)) return "setup";
  if (path.startsWith("/live/")) return "workflows";
  if (path.startsWith("/request/")) return "requests";
  if (path === HOME || path.startsWith(`${HOME}/`)) return view;
  return null;
}

export const GOOGLE_SSO = {
  strategy: "oauth_google" as const,
  redirectUrl: WORKSPACE,
  redirectCallbackUrl: SSO_CALLBACK,
};

export function destAfterAuth(
  session?: { currentTask?: { key?: string } | null; status?: string } | null,
  intent: "in" | "up" = "in",
) {
  if (session?.currentTask?.key === "choose-organization") return WORKSPACE;
  if (session?.status === "pending") return WORKSPACE;
  return intent === "up" ? TOUR : HOME;
}

/** After a workspace choice. Create and first invite → tour; returning member → home. */
export type WorkspaceChoice = "create" | "select" | "invite" | "continue";

export function destAfterWorkspace(choice: WorkspaceChoice) {
  if (choice === "create" || choice === "invite") return TOUR;
  return HOME;
}

export function continuePath(
  sessionStatus?: string | null,
  orgId?: string | null,
  intent: "in" | "up" = "in",
) {
  if (sessionStatus === "pending" || !orgId) return WORKSPACE;
  return intent === "up" ? TOUR : HOME;
}

export function signedInDest(input: {
  isAuthenticated?: boolean | null;
  sessionStatus?: string | null;
  orgId?: string | null;
}) {
  if (input.sessionStatus === "pending") return WORKSPACE;
  if (input.isAuthenticated && input.sessionStatus === "active") {
    return input.orgId ? HOME : WORKSPACE;
  }
  return null;
}

export function needsWorkspaceGate(input: {
  isAuthenticated?: boolean | null;
  sessionStatus?: string | null;
  orgId?: string | null;
}) {
  if (input.sessionStatus === "pending") return true;
  return Boolean(input.isAuthenticated && input.sessionStatus === "active" && !input.orgId);
}

export type SsoSnapshot = {
  signInStatus?: string | null;
  signUpStatus?: string | null;
  signInTransferable?: boolean;
  signUpTransferable?: boolean;
  existingSessionId?: string | null;
  sessionStatus?: string | null;
  sessionTask?: string | null;
};

export type SsoStep =
  | "session"
  | "finalize-in"
  | "finalize-up"
  | "transfer-in"
  | "transfer-up"
  | "mfa"
  | "continue-up"
  | "existing"
  | "wait"
  | "fail";

export function nextSsoStep(s: SsoSnapshot): SsoStep {
  if (s.signInStatus === "complete") return "finalize-in";
  if (s.signUpTransferable) return "transfer-in";
  if (s.signInTransferable) return "transfer-up";
  if (s.signUpStatus === "complete") return "finalize-up";
  if (
    s.signInStatus === "needs_second_factor" ||
    s.signInStatus === "needs_client_trust" ||
    s.signInStatus === "needs_new_password"
  ) {
    return "mfa";
  }
  if (s.signUpStatus === "missing_requirements") return "continue-up";
  if (s.existingSessionId) return "existing";
  if (s.sessionStatus === "pending" || s.sessionStatus === "active" || s.sessionTask) {
    return "session";
  }
  if (
    !s.signInStatus ||
    s.signInStatus === "needs_identifier" ||
    s.signInStatus === "needs_first_factor"
  ) {
    return "wait";
  }
  return "fail";
}

export function goDecorated(
  decorateUrl: (url: string) => string,
  push: (url: string) => void,
  dest = HOME,
) {
  const url = decorateUrl(dest);
  if (url.startsWith("http")) {
    window.location.href = url;
    return;
  }
  push(url);
}

export function fieldMessage(errors: unknown, name: string) {
  const fields = (errors as { fields?: Record<string, { longMessage?: string; message?: string } | undefined> } | null | undefined)
    ?.fields;
  const item = fields?.[name];
  return item?.longMessage || item?.message || "";
}

export function globalMessage(errors: unknown, fallback = "") {
  const global = (errors as { global?: Array<{ longMessage?: string; message?: string }> | null } | null | undefined)
    ?.global;
  const item = global?.[0];
  return item?.longMessage || item?.message || fallback;
}
