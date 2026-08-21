"use server";

import { revalidatePath } from "next/cache";
import { wrapFetch } from "@/lib/wrap";

const token = () => process.env.EDEN_API_KEY || "eden_dev";

export type BindEdit = { step: string; field: string; path?: string; from?: string };

async function plane(path: string, init: RequestInit): Promise<{ ok: boolean; error?: string }> {
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
