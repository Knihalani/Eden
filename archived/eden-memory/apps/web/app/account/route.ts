export type GateAuth = {
  isAuthenticated?: boolean | null;
  sessionStatus?: string | null;
  orgId?: string | null;
};

export type ProductGateInput = GateAuth & {
  path: string;
};

const LANDING = "/";
const HOME = "/home";
const SETUP = "/setup";
const TOUR = "/tour";
const WORKSPACE = "/workspace";

function at(path: string, base: string) {
  return path === base || path.startsWith(`${base}/`);
}

export function isNotesPath(path: string) {
  return at(path, "/proof") || at(path, "/isolation") || at(path, "/pack");
}

export function isAuthPagePath(path: string) {
  return at(path, "/sign-in") || at(path, "/sign-up");
}

export function isAuthFlowPath(path: string) {
  return isAuthPagePath(path) || at(path, "/sso-callback");
}

export function isWorkspacePath(path: string) {
  return at(path, WORKSPACE);
}

export function isProductPath(path: string) {
  return at(path, HOME) || at(path, TOUR) || at(path, SETUP) || at(path, "/request") || at(path, "/live");
}

/** First-run surfaces are a panel — no Home rail. */
export function isSlimPath(path: string) {
  return isWorkspacePath(path) || at(path, TOUR) || at(path, SETUP);
}

export function isInProduct(auth: GateAuth) {
  return Boolean(auth.isAuthenticated && auth.sessionStatus === "active" && auth.orgId);
}

function needsWorkspace(auth: GateAuth) {
  if (auth.sessionStatus === "pending") return true;
  return Boolean(auth.isAuthenticated && auth.sessionStatus === "active" && !auth.orgId);
}

function asInput(pathOrInput: string | ProductGateInput, auth?: GateAuth): ProductGateInput {
  if (typeof pathOrInput === "string") return { path: pathOrInput, ...auth };
  return pathOrInput;
}

/**
 * Where middleware should send this request, or `null` to stay.
 * Notes stay even if a session exists: wrap and public notes never start a handshake.
 *
 * This module must stay Edge-safe (no Node builtins, no IR package).
 */
export function productGate(pathOrInput: string | ProductGateInput, auth?: GateAuth): string | null {
  const input = asInput(pathOrInput, auth);
  const route = input.path || LANDING;

  if (isNotesPath(route)) return null;

  if (isInProduct(input) && (isAuthPagePath(route) || route === LANDING)) {
    return HOME;
  }

  if (isAuthPagePath(route) && needsWorkspace(input)) {
    return WORKSPACE;
  }

  if (needsWorkspace(input) && !isWorkspacePath(route) && !isAuthFlowPath(route)) {
    return WORKSPACE;
  }

  if (!needsWorkspace(input) && !isInProduct(input)) {
    if (isWorkspacePath(route)) return "/sign-in";
    if (isProductPath(route)) return LANDING;
  }

  return null;
}

/** App Router picks up this filename. Do not expose an account API. */
export function GET() {
  return new Response(null, { status: 404 });
}
