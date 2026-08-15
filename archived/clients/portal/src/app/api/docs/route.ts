/**
 * Docs-site Fill-in — CORS-enabled session + API-key create.
 *
 * Docs (docs.edenobservability.com) and the portal share the same
 * registrable domain, so Clerk cookies are sent with
 * ``credentials: "include"``. No popup bridge.
 *
 * GET  /api/docs  → { loggedIn, orgId?, canCreateKeys? }
 * POST /api/docs  → { apiKey, orgId }
 * OPTIONS         → CORS preflight
 */
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { forwardToBackend } from "@/lib/proxy";

export const maxDuration = 30;

const DOCS_ORIGINS = new Set([
  "https://docs.edenobservability.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
]);

/** Match ApiKeysTab SDK_DEFAULT_SCOPES — ingest/gateway required for SDK. */
const SDK_SCOPES = [
  "references:read",
  "references:write",
  "jobs:read",
  "jobs:write",
  "ingest:write",
  "gateway:write",
];

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !DOCS_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  request: NextRequest,
  body: unknown,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders(request),
  });
}

export async function OPTIONS(request: NextRequest) {
  const headers = corsHeaders(request);
  if (!headers["Access-Control-Allow-Origin"]) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers });
}

async function bearer(): Promise<string | undefined> {
  try {
    const { getToken } = await auth();
    const token = await getToken();
    return token ? `Bearer ${token}` : undefined;
  } catch {
    return undefined;
  }
}

type OrgRow = {
  id: string;
  name: string;
  role: string;
  archived_at?: string | null;
};

function pickOrg(orgs: OrgRow[], preferredId?: string | null): OrgRow | null {
  const active = orgs.filter((o) => !o.archived_at);
  const pool = active.length ? active : orgs;
  if (preferredId) {
    const preferred = pool.find((o) => o.id === preferredId);
    if (preferred) return preferred;
  }
  return (
    pool.find((o) => o.role === "owner" || o.role === "admin") ??
    pool[0] ??
    null
  );
}

/** Eden owner/admin, plus Clerk-shaped roles if they ever appear on /orgs. */
function roleCanCreateKeys(role: string | undefined | null): boolean {
  if (!role) return false;
  return (
    role === "owner" ||
    role === "admin" ||
    role === "org:admin" ||
    role === "org:owner"
  );
}

async function loadOrgs(
  authorization: string,
  cookieHeader: string | null,
): Promise<
  | { ok: true; orgs: OrgRow[] }
  | { ok: false; status: number; detail?: string }
> {
  const upstream = await forwardToBackend("/orgs", {
    method: "GET",
    authorization,
    cookieHeader: cookieHeader ?? undefined,
  });
  if (!upstream.ok) {
    // Keep the detail: GET /orgs now answers 401 for a user whose Eden
    // row has not been provisioned yet, which is NOT the same as being
    // signed out. Without the body the caller cannot tell them apart.
    let detail: string | undefined;
    try {
      const body = await upstream.json();
      detail = typeof body?.detail === "string" ? body.detail : undefined;
    } catch {
      /* non-JSON error body — leave detail undefined */
    }
    return { ok: false, status: upstream.status, detail };
  }
  try {
    const data = await upstream.json();
    const orgs: OrgRow[] = Array.isArray(data)
      ? data
      : (data?.data ?? data?.orgs ?? []);
    return { ok: true, orgs };
  } catch {
    return { ok: false, status: 502 };
  }
}

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  let authorization: string | undefined;
  try {
    const session = await auth();
    userId = session.userId;
    const token = await session.getToken();
    authorization = token ? `Bearer ${token}` : undefined;
  } catch {
    return json(request, { loggedIn: false });
  }

  if (!userId || !authorization) {
    return json(request, { loggedIn: false });
  }

  const loaded = await loadOrgs(authorization, request.headers.get("cookie"));
  if (!loaded.ok) {
    // Still signed in — orgs endpoint may be down; don't claim loggedOut.
    //
    // GET /orgs answers 401 when the caller's Eden user row has not been
    // provisioned yet. Clerk's session was already validated above, so
    // that 401 cannot mean "signed out" — mapping it to loggedIn:false
    // showed a brand-new customer "Sign in to mint a Quickstart key"
    // while they were demonstrably signed in. /auth/me auto-provisions;
    // GET /orgs does not, so this is exactly the first-run window.
    const provisioning =
      loaded.status === 401 &&
      (loaded.detail ?? "").toLowerCase().includes("provision");
    if (provisioning) {
      return json(request, {
        loggedIn: true,
        orgId: null,
        canCreateKeys: false,
        error: "Your account is still being set up. Refresh in a moment.",
      });
    }
    if (loaded.status === 401 || loaded.status === 403) {
      return json(request, { loggedIn: false });
    }
    return json(request, {
      loggedIn: true,
      orgId: null,
      canCreateKeys: false,
      error: "Could not load organizations",
    });
  }

  const preferredOrgId =
    request.headers.get("x-org-id") ||
    request.nextUrl.searchParams.get("orgId") ||
    null;

  const org = pickOrg(loaded.orgs, preferredOrgId);
  if (!org) {
    return json(request, {
      loggedIn: true,
      orgId: null,
      canCreateKeys: false,
      error: "No organization yet — create one in the portal first.",
    });
  }

  const canCreateKeys = roleCanCreateKeys(org.role);

  return json(request, {
    loggedIn: true,
    orgId: org.id,
    orgName: org.name,
    role: org.role,
    canCreateKeys,
  });
}

export async function POST(request: NextRequest) {
  const authorization = await bearer();
  if (!authorization) {
    return json(
      request,
      { error: "Sign in at edenobservability.com first." },
      401,
    );
  }

  const cookie = request.headers.get("cookie");
  let requestedOrgId: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { orgId?: string };
    requestedOrgId = typeof body.orgId === "string" ? body.orgId : undefined;
  } catch {
    requestedOrgId = undefined;
  }

  const loaded = await loadOrgs(authorization, cookie);
  if (!loaded.ok) {
    return json(request, { error: "Could not resolve organization" }, 502);
  }
  const org = pickOrg(loaded.orgs, requestedOrgId);
  if (!org) {
    return json(request, { error: "No organization found" }, 400);
  }
  if (!roleCanCreateKeys(org.role)) {
    return json(
      request,
      { error: "Only org owners and admins can create API keys." },
      403,
    );
  }
  if (requestedOrgId && org.id !== requestedOrgId) {
    return json(request, { error: "Organization not found for this user." }, 403);
  }
  const orgId = org.id;

  const createRes = await forwardToBackend(`/orgs/${orgId}/api-keys`, {
    method: "POST",
    authorization,
    cookieHeader: cookie ?? undefined,
    extraHeaders: {
      "Content-Type": "application/json",
      "X-Org-Id": orgId,
    },
    body: JSON.stringify({ name: "Quickstart", scopes: SDK_SCOPES }),
  });

  if (!createRes.ok) {
    let detail = "Could not create API key";
    try {
      const err = await createRes.json();
      detail =
        (typeof err?.detail === "string" && err.detail) ||
        err?.message ||
        detail;
    } catch {
      /* ignore */
    }
    return json(request, { error: detail }, createRes.status);
  }

  let created: { raw_key?: unknown; data?: { raw_key?: unknown }; message?: unknown } | null =
    null;
  try {
    created = await createRes.json();
  } catch {
    return json(request, { error: "Invalid create response" }, 502);
  }
  const raw = created?.raw_key ?? created?.data?.raw_key;
  if (!raw || typeof raw !== "string") {
    return json(request, { error: "No raw_key in create response" }, 502);
  }

  return json(request, { apiKey: raw, orgId });
}
