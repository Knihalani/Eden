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

const SDK_SCOPES = [
  "references:read",
  "references:write",
  "jobs:read",
  "jobs:write",
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

function pickOrg(orgs: OrgRow[]): OrgRow | null {
  const active = orgs.filter((o) => !o.archived_at);
  const pool = active.length ? active : orgs;
  return (
    pool.find((o) => o.role === "owner" || o.role === "admin") ??
    pool[0] ??
    null
  );
}

async function loadOrgs(
  authorization: string,
  cookieHeader: string | null,
): Promise<{ ok: true; orgs: OrgRow[] } | { ok: false; status: number }> {
  const upstream = await forwardToBackend("/orgs", {
    method: "GET",
    authorization,
    cookieHeader: cookieHeader ?? undefined,
  });
  if (!upstream.ok) {
    return { ok: false, status: upstream.status };
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
  const authorization = await bearer();
  if (!authorization) {
    return json(request, { loggedIn: false });
  }

  const loaded = await loadOrgs(authorization, request.headers.get("cookie"));
  if (!loaded.ok) {
    if (loaded.status === 401 || loaded.status === 403) {
      return json(request, { loggedIn: false });
    }
    return json(
      request,
      { loggedIn: false, error: "Could not load organizations" },
      502,
    );
  }

  const org = pickOrg(loaded.orgs);
  if (!org) {
    return json(request, {
      loggedIn: true,
      orgId: null,
      canCreateKeys: false,
      error: "No organization yet — create one in the portal first.",
    });
  }

  return json(request, {
    loggedIn: true,
    orgId: org.id,
    orgName: org.name,
    role: org.role,
    canCreateKeys: org.role === "owner" || org.role === "admin",
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
  let orgId: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { orgId?: string };
    orgId = typeof body.orgId === "string" ? body.orgId : undefined;
  } catch {
    orgId = undefined;
  }

  if (!orgId) {
    const loaded = await loadOrgs(authorization, cookie);
    if (!loaded.ok) {
      return json(request, { error: "Could not resolve organization" }, 502);
    }
    const org = pickOrg(loaded.orgs);
    if (!org) {
      return json(request, { error: "No organization found" }, 400);
    }
    if (org.role !== "owner" && org.role !== "admin") {
      return json(
        request,
        { error: "Only org owners and admins can create API keys." },
        403,
      );
    }
    orgId = org.id;
  }

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

  const created = await createRes.json();
  const raw = created?.raw_key ?? created?.data?.raw_key;
  if (!raw || typeof raw !== "string") {
    return json(request, { error: "No raw_key in create response" }, 502);
  }

  return json(request, { apiKey: raw, orgId });
}
