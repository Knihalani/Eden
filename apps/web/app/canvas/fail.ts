import { failureModeLabel } from "../home/activity";

export type FailKind = "failed" | "skipped" | "degraded" | "blocked";

export type CanvasFail = {
  kind: FailKind;
  step?: string;
  detail: string;
  next: string;
};

const STEP = /(?:step|tool|call|assert)[ :]['"]?([A-Za-z0-9_]+)/i;

export function namedStep(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return STEP.exec(text)?.[1];
}

function line(kind: FailKind, detail: string, next: string, step?: string): CanvasFail {
  return { kind, detail, next, ...(step ? { step } : {}) };
}

/** Same words as receipts (51): skipped / degraded / failed / blocked. */
export function classifyFail(input: {
  verdict?: string;
  reason?: string;
  skipRateAfter?: number;
  lastOk?: number | null;
  faults?: Array<{ field: string; message: string }>;
  outcome?: string;
  early?: boolean;
  skipped?: string[];
}): CanvasFail | null {
  const reason = input.reason?.trim() ?? "";
  const step = namedStep(reason);
  const skipAfter = input.skipRateAfter;

  if (input.faults?.length) {
    const f = input.faults[0]!;
    return line(
      "blocked",
      `${f.field}: ${f.message} Nothing is invented.`,
      "Name the missing path, then inspect again.",
      namedStep(f.field) ?? f.field.split(".")[0],
    );
  }

  if (input.outcome === "skipped" || (input.skipped?.length && input.lastOk === 0)) {
    return line(
      "skipped",
      reason || `Skipped ${input.skipped?.join(", ") || "a required check"}.`,
      "The method skipped a check it still needed.",
      step,
    );
  }

  if (input.outcome === "degraded") {
    return line("degraded", reason || "The run finished degraded.", "Wrap more runs so tokens and time can be measured.", step);
  }

  if (typeof skipAfter === "number" && skipAfter > 0) {
    return line(
      "skipped",
      `A required check was skipped (${skipAfter}).`,
      "Refuse this request, or pin the check before Approve.",
      step,
    );
  }

  if (/uncovered|no wrap registry|missing path|unknown step/i.test(reason)) {
    return line("blocked", reason, "Connect wrap and try again. Downstream steps stay blocked.", step);
  }

  if (/skip rate|skipped/i.test(reason)) {
    return line("skipped", reason, "The method skipped a check it still needed.", step);
  }

  if (/not measured|inconclusive/i.test(reason) || input.verdict === "INCONCLUSIVE") {
    return line(
      "degraded",
      reason || "Quality held but tokens and time were not measured.",
      "Wrap more runs so tokens and time can be measured.",
      step,
    );
  }

  if (input.lastOk === 0) {
    const early = input.early ? " Early — nothing ran." : "";
    return line(
      "failed",
      (reason || "Last compiled run failed. Downstream steps stayed blocked.") + early,
      "Pause if it is still live. Resume continues from incomplete work — completed steps stay done.",
      step,
    );
  }

  if (input.verdict === "FAIL" || /deopt|fail/i.test(reason)) {
    return line(
      "failed",
      reason || "The method failed quality.",
      step ? `Select ${step}. Downstream steps stay blocked.` : "Inspect the named step. Downstream steps stay blocked.",
      step,
    );
  }

  if (reason) {
    return line("failed", reason, "Inspect the method, then Dismiss or wait for another request.", step);
  }

  return null;
}

export function failLabel(kind: FailKind): string {
  if (kind === "skipped") return "Skipped";
  if (kind === "degraded") return "Degraded";
  if (kind === "blocked") return "Blocked";
  return "Failed";
}

function outcomeWord(rec: { outcome?: string; ok?: number | boolean }): string {
  if (rec.outcome === "ok") return "Ok";
  if (rec.outcome === "deopt") return "Fell back";
  if (rec.outcome === "skipped") return "Skipped";
  if (rec.outcome === "degraded") return "Degraded";
  if (rec.ok === 1 || rec.ok === true) return "Ok";
  return "Failed";
}

function savedThisRun(n: number | null | undefined, unit: string): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n > 0) return `${Math.round(n)}${unit} saved this run`;
  if (n < 0) return `${Math.round(-n)}${unit} over the tape`;
  return "matched the tape";
}

/** Same drill-in as 25/27: what the last compiled run actually did (51, 37). */
export function receiptPostmortem(
  rec: {
    ok?: number | boolean;
    outcome?: string;
    deoptReason?: string;
    early?: boolean;
    stepsRun?: number;
    skipped?: string[];
    tokensSaved?: number | null;
    timeSavedMs?: number | null;
    ms?: number;
  },
  opts?: { budgetMs?: number; drift?: boolean },
): string {
  return [
    outcomeWord(rec),
    rec.early ? "early" : null,
    rec.stepsRun != null ? `${rec.stepsRun} steps` : null,
    rec.deoptReason ? rec.deoptReason.replace(/^deopt:\s*/i, "") : null,
    rec.skipped?.length ? `skipped ${rec.skipped.join(", ")}` : null,
    opts?.drift ? "fingerprint moved" : null,
    savedThisRun(rec.timeSavedMs, "ms"),
    rec.tokensSaved != null && rec.tokensSaved > 0 ? `${Math.round(rec.tokensSaved)} tokens saved this run` : null,
    rec.ms != null ? `${Math.round(rec.ms)}ms this run` : null,
    opts?.budgetMs != null && opts.budgetMs > 0 ? `budget ${Math.round(opts.budgetMs)}ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Same failure-mode words as the home list, as a canvas sentence (50). */
export function originLine(origin?: { mode: string; firstWarningAt?: number } | null): string | null {
  if (!origin?.mode || origin.mode === "happy") return null;
  const noun = failureModeLabel(origin.mode);
  const head = `Compiled from a ${noun[0]!.toLowerCase()}${noun.slice(1)}`;
  return origin.firstWarningAt != null ? `${head} · warning at call ${origin.firstWarningAt}` : head;
}
