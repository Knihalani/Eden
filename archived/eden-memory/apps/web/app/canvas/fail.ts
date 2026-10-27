import { stretchLine, stretchSentence, type StretchWord } from "@eden/measure";
import { refusalStatus, type RefusalCode } from "@eden/ir";
import { failureModeLabel } from "../home/activity";
import { cacheReadsLine } from "./cache-reads";

export { stretchLine, stretchSentence, type StretchWord };

export type FailKind = "failed" | "skipped" | "degraded" | "blocked";

export type CanvasFail = {
  kind: FailKind;
  step?: string;
  detail: string;
  next: string;
  /** Whole-stretch sentence when receipts span more than the latest row. */
  stretch?: string;
  stretchWords?: StretchWord[];
};

const STEP = /(?:\bstep|\bcall|\bassert)[ :]['"]?([A-Za-z0-9_]+)/i;

export function namedStep(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return STEP.exec(text)?.[1];
}

function line(kind: FailKind, detail: string, next: string, step?: string): CanvasFail {
  return { kind, detail, next, ...(step ? { step } : {}) };
}

/** Same words as receipts (51) and the canary draft row a person Approves. */
export const REFRESH_WAITING_COPY =
  "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.";

export function classifyFail(input: {
  verdict?: string;
  reason?: string;
  skipRateAfter?: number;
  lastOk?: number | null;
  faults?: Array<{ field: string; message: string }>;
  outcome?: string;
  early?: boolean;
  skipped?: string[];
  tokenClass?: string;
  programName?: string;
  /** Live tool drifted; a recompiled replacement is waiting on the desk. */
  drift?: boolean;
  refreshWaiting?: boolean;
  /** Agents that shared this serving. Omitted at 1. */
  sharedAcross?: number;
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

  if (
    input.refreshWaiting ||
    input.drift ||
    /the outside world renamed a field|a replacement is waiting|renamed a field/i.test(reason)
  ) {
    return line(
      "degraded",
      "The outside world renamed a field. A replacement is waiting.",
      "The live tool is unchanged until you Approve.",
      step,
    );
  }

  if (/capacity: session full/i.test(reason)) {
    return line(
      "degraded",
      "This stretch ran raw — the session's suppression table was full.",
      "Other sessions were not dropped. Savings resume when a slot frees.",
      step,
    );
  }

  const sharedN =
    typeof input.sharedAcross === "number" && input.sharedAcross >= 2
      ? input.sharedAcross
      : Number(/shared across (\d+) agents/.exec(reason)?.[1]);
  if (Number.isFinite(sharedN) && sharedN >= 2) {
    return line(
      "skipped",
      `shared across ${sharedN} agents`,
      "The remaining steps of this routine were already served.",
      step,
    );
  }

  if (
    /host kept the original/i.test(reason) ||
    /dropped the rewrite/i.test(reason) ||
    /silent.?drop/i.test(reason) ||
    /updatedToolOutput was dropped/i.test(reason)
  ) {
    return line(
      "degraded",
      "The host kept the original tool output. Facts are still attached as context.",
      "Rely on that context; remainder deny will stop duplicate work.",
    );
  }

  const servedBy = /already served by\s+([A-Za-z0-9_-]+)/i.exec(reason)?.[1];
  if (servedBy || /remaining steps of this routine/i.test(reason)) {
    const reRun = /do not re-run\s+([A-Za-z0-9_-]+)/i.exec(reason)?.[1];
    return line(
      "skipped",
      servedBy
        ? `Already served by ${servedBy}. The remaining steps of this routine were already served.`
        : "The remaining steps of this routine were already served.",
      "Do not re-run — facts are in the last tool output or attached as context.",
      reRun ?? step,
    );
  }

  // Hook ledger / wrap skipRest: remainder is a successful head plus named
  // tails. Do not wait for the exact deny sentence to already be on `reason`.
  if (input.tokenClass === "steered-skip" || (input.skipped?.length && input.lastOk === 1)) {
    const program = input.programName?.trim() || "this routine";
    const tool = input.skipped?.[0];
    return line(
      "skipped",
      `Already served by ${program}. The remaining steps of this routine were already served.`,
      "Do not re-run — facts are in the last tool output or attached as context.",
      tool,
    );
  }

  if (/timeout \d+ms/i.test(reason) || /wrap timeout/i.test(reason)) {
    return line(
      "failed",
      "The compiled run hit the wrap timeout. Completed writes stay done.",
      "Retry the unfinished step — it will not replay what already ran.",
      step,
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
    return line(
      "degraded",
      reason || "The run finished degraded.",
      "Wrap more runs so tokens and time can be measured.",
      step,
    );
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
      step
        ? `Select ${step}. Downstream steps stay blocked.`
        : "Inspect the named step. Downstream steps stay blocked.",
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

function outcomeWord(rec: { outcome?: string; ok?: number | boolean; deoptReason?: string }): string {
  if (rec.outcome === "ok") return "Ok";
  if (typeof rec.deoptReason === "string" && /timeout \d+ms/i.test(rec.deoptReason)) return "Wrap timeout";
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
    cache_hits?: number | null;
    cache_lookups?: number | null;
    sharedAcross?: number;
    reason?: string;
  },
  opts?: { budgetMs?: number; drift?: boolean; stretchWords?: StretchWord[] },
): string {
  return [
    opts?.stretchWords?.length ? stretchSentence(opts.stretchWords) : null,
    outcomeWord(rec),
    rec.early ? "early" : null,
    rec.stepsRun != null ? `${rec.stepsRun} steps` : null,
    rec.deoptReason ? rec.deoptReason.replace(/^deopt:\s*/i, "") : null,
    rec.skipped?.length ? `skipped ${rec.skipped.join(", ")}` : null,
    typeof rec.sharedAcross === "number" && rec.sharedAcross >= 2 ? `shared across ${rec.sharedAcross} agents` : null,
    rec.reason &&
    /shared across \d+ agents/.test(rec.reason) &&
    !(typeof rec.sharedAcross === "number" && rec.sharedAcross >= 2)
      ? rec.reason
      : null,
    opts?.drift ? REFRESH_WAITING_COPY : null,
    cacheReadsLine(rec.cache_hits, rec.cache_lookups),
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

/** Contract strip for a composed join. Live stays off until Approve. */
export function handoffContractLine(
  program: { composedOf?: string[]; sequence?: string[] } | null | undefined,
  originMode?: string,
): string | null {
  if (!program?.composedOf?.length) return null;
  const names = (program.sequence ?? []).filter(Boolean).join(" → ");
  const who = names || `${program.composedOf.length} child programs`;
  const noun = originMode === "compose" ? "Compose" : "Handoff";
  return `${noun} of ${who}. Live tool unchanged until you Approve.`;
}

/** Sibling strip: same short label as Home Needs attention, not `Refused · ${raw}`. */
export function siblingStatus(row: {
  verdict: string;
  reason?: string;
  code?: string;
  readSet?: number;
  repeats?: number;
}): string {
  if (row.verdict === "PASS") return "Ready";
  if (row.verdict === "INCONCLUSIVE") return "Not measured";
  if (row.verdict === "FAIL") {
    return refusalStatus({
      code: row.code as RefusalCode | undefined,
      reason: row.reason ?? "",
      readSet: row.readSet,
      repeats: row.repeats,
    });
  }
  return row.verdict;
}

/** Side panel when nothing is selected. Refused empty-graph uses the same diagnosis as the stage. */
export function emptyPanelCopy(opts: { program: unknown; refusal?: string }): string {
  if (!opts.program && opts.refusal) return opts.refusal;
  return "Select a step to inspect bindings, reads, and writes.";
}
