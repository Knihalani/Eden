import { wrapFetch } from "@/lib/wrap";
import type { Manifest, StretchProgram } from "@eden/ir";
import { hashStretch } from "@eden/ir";
import { classifyFail } from "./fail";
import type { CanvasModel, CanvasReceipt, CanvasSibling } from "./model";

export type { CanvasFail, CanvasModel, CanvasSibling } from "./model";

const token = () => process.env.EDEN_API_KEY || "eden_dev";

async function plane(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token()}`);
  return wrapFetch()(new Request(`http://eden.local${path}`, { ...init, headers }));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export type LoadCanvasResult =
  | { status: "ok"; model: CanvasModel }
  | { status: "miss" }
  | { status: "error" };

export async function loadCanvas(mode: "request" | "live", id: string): Promise<LoadCanvasResult> {
  try {
    if (mode === "live") {
      const res = await plane(`/v1/tools/${encodeURIComponent(id)}`);
      if (res.status === 404) return { status: "miss" };
      if (!res.ok) return { status: "error" };
      const tool = asRecord(await res.json());
      if (!tool) return { status: "miss" };
      const program = (tool.program as StretchProgram) ?? null;
      const pinned = typeof tool.version === "string" ? tool.version : program?.version ?? "";
      let liveVersion: string | undefined;
      if (tool.state === "live") {
        const live = await plane(`/v1/tools/${encodeURIComponent(id)}/program`);
        if (live.ok) {
          const body = asRecord(await live.json());
          liveVersion = typeof body?.version === "string" ? body.version : program?.version;
        }
      }
      const receiptsRes = await plane(`/v1/receipts?tool=${encodeURIComponent(id)}`);
      const receiptsJson = receiptsRes.ok ? asRecord(await receiptsRes.json()) : null;
      const receipts = Array.isArray(receiptsJson?.receipts) ? receiptsJson.receipts : [];
      const last = asRecord(receipts[0]);
      const receipt = last
        ? {
            ok: last.ok as number | boolean | undefined,
            outcome: typeof last.outcome === "string" ? last.outcome : undefined,
            deoptReason: typeof last.deoptReason === "string" ? last.deoptReason : undefined,
            reason: typeof last.reason === "string" ? last.reason : undefined,
            early: last.early === true,
            stepsRun: Number.isFinite(Number(last.stepsRun)) ? Number(last.stepsRun) : undefined,
            skipped: Array.isArray(last.skipped)
              ? last.skipped.filter((n): n is string => typeof n === "string")
              : undefined,
            fingerprint: typeof last.fingerprint === "string" ? last.fingerprint : undefined,
            tokensSaved: typeof last.tokensSaved === "number" ? last.tokensSaved : null,
            timeSavedMs: typeof last.timeSavedMs === "number" ? last.timeSavedMs : null,
            ms: typeof last.ms === "number" ? last.ms : undefined,
            llm_calls: typeof last.llm_calls === "number" ? last.llm_calls : undefined,
          }
        : null;
      const lastOk = last?.ok === 1 || last?.ok === true ? 1 : last?.ok === 0 || last?.ok === false ? 0 : null;
      const fail = classifyFail({
        skipRateAfter: program?.manifest?.skipRateAfter,
        lastOk,
        reason: receipt?.deoptReason || receipt?.reason,
        outcome: receipt?.outcome,
        early: receipt?.early,
        skipped: receipt?.skipped,
      });
      const drift = Boolean(program && receipt?.fingerprint && receipt.fingerprint !== hashStretch(program));
      return {
        status: "ok",
        model: {
          mode,
          id,
          name: typeof tool.name === "string" ? tool.name : id,
          program,
          version: pinned,
          pinnedVersion: pinned || undefined,
          liveVersion,
          state: typeof tool.state === "string" ? tool.state : "live",
          manifest: (program?.manifest as Manifest | null) ?? null,
          siblings: [],
          fail,
          receipt,
          drift,
        },
      };
    }

    const res = await plane("/v1/candidates");
    if (!res.ok) return { status: "error" };
    const body = asRecord(await res.json());
    const list = Array.isArray(body?.candidates) ? body.candidates : [];
    const hit = list.map(asRecord).find((row) => row?.id === id);
    if (!hit) return { status: "miss" };
    const program = (hit.program as StretchProgram) ?? null;
    const refusal = asRecord(hit.refusal);
    const reason = typeof refusal?.reason === "string" ? refusal.reason : undefined;
    const manifest = ((hit.manifest as Manifest | null) ?? program?.manifest) || null;
    const siblings: CanvasSibling[] = list
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => Boolean(row && row.id !== id))
      .map((row) => {
        const p = asRecord(row.program);
        const r = asRecord(row.refusal);
        return {
          id: String(row.id),
          name: (typeof p?.name === "string" && p.name) || String(row.id),
          verdict: typeof row.verdict === "string" ? row.verdict : "pending",
          reason: typeof r?.reason === "string" ? r.reason : undefined,
        };
      });
    return {
      status: "ok",
      model: {
        mode,
        id,
        name: program?.name || id,
        program,
        version: program?.version ?? "",
        verdict: typeof hit.verdict === "string" ? hit.verdict : "pending",
        refusal: reason,
        manifest,
        siblings,
        fail: classifyFail({
          verdict: typeof hit.verdict === "string" ? hit.verdict : undefined,
          reason,
          skipRateAfter: manifest?.skipRateAfter,
        }),
      },
    };
  } catch {
    return { status: "error" };
  }
}
