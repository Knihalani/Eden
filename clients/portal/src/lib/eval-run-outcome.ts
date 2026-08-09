/**
 * Shared outcome helpers for red-team scans and offline experiment runs.
 * Keeps toast/ErrorState decisions honest (no false success on empty/stub/pending).
 */

export type RedteamScanRunRow = {
  failure_count?: number;
  prompts_executed?: number;
};

export type RedteamScanOutcome =
  | { kind: "success"; findingCount: 0 }
  | { kind: "findings"; findingCount: number }
  | { kind: "empty"; message: string };

/** Interpret POST /redteam/scan body — failure_count means probe findings, not HTTP failure. */
export function interpretRedteamScan(res: {
  runs?: RedteamScanRunRow[] | null;
}): RedteamScanOutcome {
  const runs = res.runs ?? [];
  const prompts = runs.reduce((n, r) => n + (r.prompts_executed ?? 0), 0);
  const findingCount = runs.reduce((n, r) => n + (r.failure_count ?? 0), 0);
  if (runs.length === 0 || prompts === 0) {
    return {
      kind: "empty",
      message:
        "Scan returned no executed probes. Check the target endpoint and try again.",
    };
  }
  if (findingCount > 0) {
    return { kind: "findings", findingCount };
  }
  return { kind: "success", findingCount: 0 };
}

export type OfflineRunResult = {
  status?: string;
  synthetic?: boolean;
  method?: string;
  rows?: number;
};

export type OfflineRunOutcome =
  | { kind: "completed"; synthetic: boolean; message: string }
  | { kind: "failed"; synthetic: boolean; message: string }
  | { kind: "in_progress"; synthetic: boolean; message: string }
  | { kind: "invalid"; synthetic: boolean; message: string };

export function isTerminalExperimentStatus(status: string): boolean {
  return status === "completed" || status === "failed";
}

export function shouldPollExperimentStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

/** Interpret POST /experiments/offline/{id}/run result — never treat missing status as success. */
export function interpretOfflineRunResult(
  result: OfflineRunResult | null | undefined,
): OfflineRunOutcome {
  if (!result || typeof result.status !== "string" || !result.status.trim()) {
    return {
      kind: "invalid",
      synthetic: false,
      message: "Run returned no status",
    };
  }
  const synthetic = Boolean(result.synthetic);
  const status = result.status.trim();
  if (status === "failed") {
    return {
      kind: "failed",
      synthetic,
      message: "Experiment run failed",
    };
  }
  if (shouldPollExperimentStatus(status)) {
    return {
      kind: "in_progress",
      synthetic,
      message: "Experiment running…",
    };
  }
  if (status === "completed") {
    return {
      kind: "completed",
      synthetic,
      message: synthetic
        ? result.method === "offline_fallback"
          ? "Offline fallback run finished — not a live model eval"
          : result.method === "heuristic_stub"
            ? "Legacy heuristic run finished — not a live model eval"
            : "Synthetic run finished — not a live model eval"
        : "Experiment completed",
    };
  }
  return {
    kind: "invalid",
    synthetic,
    message: `Unexpected run status: ${status}`,
  };
}
