"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { wrapFetch } from "@/lib/wrap";

const token = () => process.env.EDEN_API_KEY || "eden_dev";

export type BindEdit = { step: string; field: string; path?: string; from?: string };

/**
 * Clerk is the only real gate: every action shares one bearer token for the
 * embedded control plane, so an unauthenticated caller, a session without an
 * active workspace, or a pending session must be refused here — before any
 * control-plane request is built.
 */
async function gate(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, orgId, sessionStatus } = await auth();
  if (!userId) return { ok: false, error: "sign in to manage live tools" };
  if (!orgId) return { ok: false, error: "join or create a workspace first" };
  if (sessionStatus !== "active") return { ok: false, error: "your session is not active yet" };
  return { ok: true };
}

async function plane(path: string, init: RequestInit): Promise<{ ok: boolean; error?: string }> {
  const g = await gate();
  if (!g.ok) return g;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token()}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await wrapFetch()(new Request(`http://eden.local${path}`, { ...init, headers }));
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error || `HTTP ${res.status}` };
}

export async function approveTool(id: string, drop: string[] = [], bind: BindEdit[] = []) {
  const edits: { drop?: string[]; bind?: BindEdit[] } = {};
  if (drop.length) edits.drop = drop;
  if (bind.length) edits.bind = bind;
  const out = await plane(`/v1/tools/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify(Object.keys(edits).length ? { edits } : {}),
  });
  revalidatePath("/home");
  revalidatePath(`/request/${id}`);
  revalidatePath(`/live/${id}`);
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
