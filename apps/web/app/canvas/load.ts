import { wrapFetch } from "@/lib/wrap";
import { edenKey } from "../lib/eden-key";
import {
  hashStretch,
  TOKEN_CLASSES,
  refusalCopy,
  type Manifest,
  type RefusalCode,
  type StretchProgram,
  type TokenClass,
} from "@eden/ir";
import { asTokenClasses, stretchSentence, stretchWords, type StretchWord } from "@eden/measure";
import { programDecor } from "./contract";
import { classifyFail, siblingStatus } from "./fail";
import type { CanvasFail, CanvasModel, CanvasReceipt, CanvasSibling } from "./model";

export type { CanvasFail, CanvasModel, CanvasSibling } from "./model";

async function plane(path: string, init?: RequestInit): Promise<Response> {
  // Read-only routes stay key-gated; no org binding needed here.
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${edenKey()}`);
  return wrapFetch()(new Request(`http://eden.local${path}`, { ...init, headers }));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Null / missing offset stays omitted. Real 0 is call 0. `Number(null)` is 0 and must not leak. */
export function canvasOrigin(
  originRec: Record<string, unknown> | null,
): { mode: string; firstWarningAt?: number } | undefined {
  if (!originRec) return undefined;
  const mode = typeof originRec.mode === "string" && originRec.mode !== "happy" ? originRec.mode : undefined;
  if (!mode) return undefined;
  const rawWarn = originRec.firstWarningAt;
  const warnAt = Number(rawWarn);
  return {
    mode,
    ...(rawWarn != null && rawWarn !== "" && Number.isFinite(warnAt) ? { firstWarningAt: Math.round(warnAt) } : {}),
  };
}

function newestRow(receipts: unknown[]): Record<string, unknown> | null {
  // Assigned only inside the forEach callback, so keep TS from narrowing it to `null` here.
  let best = null as { t: number; order: number; row: Record<string, unknown> } | null;
  receipts.forEach((raw, order) => {
    const row = asRecord(raw);
    if (!row) return;
    const n = Number(row.created_at);
    const t = Number.isFinite(n) && n > 0 ? n : 0;
    if (!best || t > best.t || (t === best.t && order < best.order)) {
      best = { t, order, row };
    }
  });
  return best?.row ?? null;
}

function withStretch(fail: ReturnType<typeof classifyFail>, words: StretchWord[]): CanvasFail | null {
  if (!words.length) return fail;
  const stretch = stretchSentence(words);
  if (fail) return { ...fail, stretch, stretchWords: words };
  if (!words.includes("Degraded")) return fail;
  return {
    kind: "degraded",
    detail: stretch,
    next: "Rely on that context; remainder deny will stop duplicate work.",
    stretch,
    stretchWords: words,
  };
}

/** Receipts → canvas fail. Latest row classifies; the whole stretch is named. */
export function liveFailFromReceipt(
  program: StretchProgram | null | undefined,
  last: Record<string, unknown> | unknown[] | null,
  opts?: { refreshWaiting?: boolean },
): {
  receipt: CanvasReceipt | null;
  fail: CanvasFail | null;
  lastOk: 0 | 1 | null;
  stretchWords: StretchWord[];
} {
  const receipts = Array.isArray(last) ? last : last ? [last] : [];
  const newest = newestRow(receipts);
  const receipt = newest
    ? {
        ok: newest.ok as number | boolean | undefined,
        outcome: typeof newest.outcome === "string" ? newest.outcome : undefined,
        deoptReason: typeof newest.deoptReason === "string" ? newest.deoptReason : undefined,
        reason: typeof newest.reason === "string" ? newest.reason : undefined,
        early: newest.early === true,
        stepsRun: Number.isFinite(Number(newest.stepsRun)) ? Number(newest.stepsRun) : undefined,
        skipped: Array.isArray(newest.skipped)
          ? newest.skipped.filter((n): n is string => typeof n === "string")
          : undefined,
        fingerprint: typeof newest.fingerprint === "string" ? newest.fingerprint : undefined,
        tokenClass:
          typeof newest.tokenClass === "string" && (TOKEN_CLASSES as readonly string[]).includes(newest.tokenClass)
            ? (newest.tokenClass as TokenClass)
            : undefined,
        tokenClasses: asTokenClasses(newest.tokenClasses) ?? undefined,
        prompt_tokens:
          typeof newest.prompt_tokens === "number" && Number.isFinite(newest.prompt_tokens)
            ? newest.prompt_tokens
            : undefined,
        completion_tokens:
          typeof newest.completion_tokens === "number" && Number.isFinite(newest.completion_tokens)
            ? newest.completion_tokens
            : undefined,
        cached_tokens:
          typeof newest.cached_tokens === "number" && Number.isFinite(newest.cached_tokens)
            ? newest.cached_tokens
            : undefined,
        cache_write_tokens:
          typeof newest.cache_write_tokens === "number" && Number.isFinite(newest.cache_write_tokens)
            ? newest.cache_write_tokens
            : undefined,
        cache_input_tokens:
          typeof newest.cache_input_tokens === "number" && Number.isFinite(newest.cache_input_tokens)
            ? newest.cache_input_tokens
            : undefined,
        tokensSaved: typeof newest.tokensSaved === "number" ? newest.tokensSaved : null,
        timeSavedMs: typeof newest.timeSavedMs === "number" ? newest.timeSavedMs : null,
        ms: typeof newest.ms === "number" ? newest.ms : undefined,
        llm_calls: typeof newest.llm_calls === "number" ? newest.llm_calls : undefined,
        cache_hits:
          typeof newest.cache_hits === "number" && Number.isFinite(newest.cache_hits) ? newest.cache_hits : undefined,
        cache_lookups:
          typeof newest.cache_lookups === "number" && Number.isFinite(newest.cache_lookups)
            ? newest.cache_lookups
            : undefined,
        cache_hit_rate:
          typeof newest.cache_hit_rate === "number" && Number.isFinite(newest.cache_hit_rate)
            ? newest.cache_hit_rate
            : undefined,
      }
    : null;
  const lastOk = newest?.ok === 1 || newest?.ok === true ? 1 : newest?.ok === 0 || newest?.ok === false ? 0 : null;
  const words = stretchWords(receipts);
  const fail = withStretch(
    classifyFail({
      skipRateAfter: program?.manifest?.skipRateAfter,
      lastOk,
      reason: receipt?.deoptReason || receipt?.reason,
      outcome: receipt?.outcome,
      early: receipt?.early,
      skipped: receipt?.skipped,
      tokenClass: receipt?.tokenClass,
      programName: program?.name,
      refreshWaiting: opts?.refreshWaiting === true,
    }),
    words,
  );
  return { receipt, lastOk, fail, stretchWords: words };
}

export type LoadCanvasResult = { status: "ok"; model: CanvasModel } | { status: "miss" } | { status: "error" };

export async function loadCanvas(mode: "request" | "live", id: string): Promise<LoadCanvasResult> {
  try {
    if (mode === "live") {
      const [res, receiptsRes] = await Promise.all([
        plane(`/v1/tools/${encodeURIComponent(id)}`),
        plane(`/v1/receipts?tool=${encodeURIComponent(id)}`),
      ]);
      if (res.status === 404) return { status: "miss" };
      if (!res.ok) return { status: "error" };
      const tool = asRecord(await res.json());
      if (!tool) return { status: "miss" };
      const program = (tool.program as StretchProgram) ?? null;
      const pinned = typeof tool.version === "string" ? tool.version : (program?.version ?? "");
      let liveVersion: string | undefined;
      if (tool.state === "live") {
        liveVersion = typeof tool.version === "string" ? tool.version : program?.version;
      }
      const receiptsJson = receiptsRes.ok ? asRecord(await receiptsRes.json()) : null;
      const receipts = Array.isArray(receiptsJson?.receipts) ? receiptsJson.receipts : [];
      const refreshWaiting = Boolean(asRecord(tool.candidate));
      const { receipt, fail } = liveFailFromReceipt(program, receipts, { refreshWaiting });
      const drift = Boolean(program && receipt?.fingerprint && receipt.fingerprint !== hashStretch(program));
      const decor = programDecor(program);
      const rollout = tool.rollout === "canary" || tool.rollout === "live" ? tool.rollout : undefined;
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
          ...(rollout ? { rollout } : {}),
          envelopeLine: decor.envelopeLine,
          ...(decor.llmBadge ? { llmBadge: decor.llmBadge } : {}),
        },
      };
    }

    const [res, listRes] = await Promise.all([
      plane(`/v1/candidates/${encodeURIComponent(id)}`),
      plane("/v1/candidates"),
    ]);
    if (res.status === 404) return { status: "miss" };
    if (!res.ok) return { status: "error" };
    const hit = asRecord(await res.json());
    if (!hit || hit.id !== id) return { status: "miss" };
    const program = (hit.program as StretchProgram) ?? null;
    const refusal = asRecord(hit.refusal);
    const reason = typeof refusal?.reason === "string" ? refusal.reason : undefined;
    const diagnosis =
      refusal && reason
        ? refusalCopy({
            reason,
            code: typeof refusal.code === "string" ? (refusal.code as RefusalCode) : undefined,
            readSet: Number.isFinite(Number(refusal.readSet)) ? Number(refusal.readSet) : undefined,
            repeats: Number.isFinite(Number(refusal.repeats)) ? Number(refusal.repeats) : undefined,
            hint: typeof refusal.hint === "string" ? refusal.hint : undefined,
            slot: typeof refusal.slot === "string" ? refusal.slot : undefined,
          })
        : reason;
    const manifest = ((hit.manifest as Manifest | null) ?? program?.manifest) || null;
    const originRec = program ? asRecord((program as { origin?: unknown }).origin) : asRecord(hit.origin);
    const origin = canvasOrigin(originRec);
    const listBody = listRes.ok ? asRecord(await listRes.json()) : null;
    const list = Array.isArray(listBody?.candidates) ? listBody.candidates : [];
    const siblings: CanvasSibling[] = list
      .map(asRecord)
      .filter((row): row is Record<string, unknown> => Boolean(row && row.id !== id))
      .map((row) => {
        const p = asRecord(row.program);
        const r = asRecord(row.refusal);
        const verdict = typeof row.verdict === "string" ? row.verdict : "pending";
        return {
          id: String(row.id),
          name: (typeof p?.name === "string" && p.name) || String(row.id),
          verdict,
          status: siblingStatus({
            verdict,
            reason: typeof r?.reason === "string" ? r.reason : undefined,
            code: typeof r?.code === "string" ? r.code : undefined,
            // Number(undefined) is NaN, so a finite count means `r` is non-null.
            readSet: Number.isFinite(Number(r?.readSet)) ? Number(r!.readSet) : undefined,
            repeats: Number.isFinite(Number(r?.repeats)) ? Number(r!.repeats) : undefined,
          }),
        };
      });
    const decor = programDecor(program);
    return {
      status: "ok",
      model: {
        mode,
        id,
        name: program?.name || id,
        program,
        version: program?.version ?? "",
        verdict: typeof hit.verdict === "string" ? hit.verdict : "pending",
        refusal: diagnosis,
        manifest,
        siblings,
        fail: program
          ? classifyFail({
              verdict: typeof hit.verdict === "string" ? hit.verdict : undefined,
              reason: reason || (typeof program.description === "string" ? program.description : undefined),
              skipRateAfter: manifest?.skipRateAfter,
              refreshWaiting: /replacement is waiting/i.test(program.description ?? ""),
            })
          : null,
        envelopeLine: decor.envelopeLine,
        ...(decor.llmBadge ? { llmBadge: decor.llmBadge } : {}),
        ...(origin ? { origin } : {}),
      },
    };
  } catch {
    return { status: "error" };
  }
}
