"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { wrapFetch } from "@/lib/wrap";
import { edenKey } from "../lib/eden-key";

export type BindEdit = { step: string; field: string; path?: string; from?: string };

/**
 * Clerk is the only real gate: every action shares one bearer token for the
 * embedded control plane, so an unauthenticated caller, a session without an
 * active workspace, or a pending session must be refused here — before any
 * control-plane request is built. The caller's org id travels along as
 * x-eden-org so the control plane can bind the action to this tenant.
 */
async function gate(): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  const { userId, orgId, sessionStatus } = await auth();
  if (!userId) return { ok: false, error: "sign in to manage live tools" };
  if (!orgId) return { ok: false, error: "join or create a workspace first" };
  if (sessionStatus !== "active") return { ok: false, error: "your session is not active yet" };
  return { ok: true, orgId };
}

function authHeaders(orgId?: string): Headers | { error: string } {
  let key: string;
  try {
    key = edenKey();
  } catch (err) {
    return { error: err instanceof Error ? err.message : "control-plane key is not configured" };
  }
  const headers = new Headers();
  headers.set("authorization", `Bearer ${key}`);
  if (orgId) headers.set("x-eden-org", orgId);
  return headers;
}

async function plane(path: string, init: RequestInit): Promise<{ ok: boolean; error?: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const authed = authHeaders(g.orgId);
  if ("error" in authed) return { ok: false, error: authed.error };
  const headers = new Headers(init.headers);
  for (const [k, v] of authed) headers.set(k, v);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await wrapFetch()(new Request(`http://eden.local${path}`, { ...init, headers }));
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error || `HTTP ${res.status}` };
}

/**
 * Provisioning: register the caller's org against the workspace so later
 * approve/pause/dismiss calls pass the control plane's tenant gate. Called on
 * onboarding ("with keys"); best-effort there, but exported so any flow that
 * connects a workspace can do the same.
 */
export async function bindWorkspaceOrg(): Promise<{ ok: boolean; error?: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const authed = authHeaders(g.orgId);
  if ("error" in authed) return { ok: false, error: authed.error };
  const res = await wrapFetch()(
    new Request("http://eden.local/v1/workspace/orgs", {
      method: "POST",
      headers: new Headers([...authed, ["content-type", "application/json"]]),
      body: JSON.stringify({ org_id: g.orgId }),
    }),
  );
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error || `HTTP ${res.status}` };
}

export async function approveTool(
  id: string,
  drop: string[] = [],
  bind: BindEdit[] = [],
  opts?: {
    transparentWrites?: boolean;
    dropValues?: Array<{ path: string; value: unknown }>;
    pinIslands?: boolean;
  },
) {
  const body: {
    edits?: { drop?: string[]; bind?: BindEdit[] };
    transparent_writes?: boolean;
    dropValues?: Array<{ path: string; value: unknown }>;
    pinIslands?: boolean;
  } = {};
  const edits: { drop?: string[]; bind?: BindEdit[] } = {};
  if (drop.length) edits.drop = drop;
  if (bind.length) edits.bind = bind;
  if (Object.keys(edits).length) body.edits = edits;
  if (opts?.transparentWrites) body.transparent_writes = true;
  if (opts?.dropValues?.length) body.dropValues = opts.dropValues;
  if (opts?.pinIslands) body.pinIslands = true;
  const out = await plane(`/v1/tools/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify(Object.keys(body).length ? body : {}),
  });
  revalidatePath("/home");
  revalidatePath(`/request/${id}`);
  revalidatePath(`/live/${id}`);
  return out;
}

export async function promoteTool(id: string) {
  const out = await plane(`/v1/tools/${encodeURIComponent(id)}/promote`, { method: "POST", body: "{}" });
  revalidatePath(`/live/${id}`);
  revalidatePath("/home");
  return out;
}

export async function pauseTool(id: string) {
  const out = await plane(`/v1/tools/${encodeURIComponent(id)}/pause`, { method: "POST", body: "{}" });
  revalidatePath(`/live/${id}`);
  revalidatePath("/home");
  return out;
}

export async function resumeTool(id: string) {
  const out = await plane(`/v1/tools/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" });
  revalidatePath(`/live/${id}`);
  revalidatePath("/home");
  return out;
}

export async function dismissRequest(id: string) {
  const out = await plane(`/v1/candidates/${encodeURIComponent(id)}`, { method: "DELETE" });
  revalidatePath("/home");
  return out;
}
