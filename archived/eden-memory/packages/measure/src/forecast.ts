/**
 * Predicted program spend vs actual run spend and remaining timeout.
 *
 * Halt is a comparison, not a slur: llmCalls / ms / cents on the program
 * against what the run has already spent, plus whether predicted ms still
 * fits the timeout left. Unique-work has no predicted triple, so this meter
 * is never asked to halt it.
 */

export type ForecastSpend = {
  llmCalls: number;
  ms: number;
  cents: number;
};

/** Which dimension first justified a halt. `timeout` is predicted ms vs cap left. */
export type ForecastOverflow = "llmCalls" | "ms" | "cents" | "timeout" | null;

export type ForecastView = {
  predicted: ForecastSpend;
  actual: ForecastSpend;
  /** predicted − actual (negative means already over). */
  remaining: ForecastSpend;
  remainingTimeoutMs: number;
  /** Actual already meets/exceeds a positive predicted dimension. */
  spent: boolean;
  /** Predicted ms does not fit remaining timeout (existing time-pressure gate). */
  timeoutPressure: boolean;
  /** Enforce would halt: spent or timeoutPressure. */
  halt: boolean;
  overflow: ForecastOverflow;
};

function num(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function spend(partial: Partial<ForecastSpend> | undefined | null): ForecastSpend {
  return {
    llmCalls: num(partial?.llmCalls),
    ms: num(partial?.ms),
    cents: num(partial?.cents),
  };
}

/**
 * Remaining of the predicted triple vs spend already on the run, and whether
 * that prediction still fits the timeout cap left.
 */
export function remainingBudget(args: {
  predicted: Partial<ForecastSpend> | undefined | null;
  actual: Partial<ForecastSpend> | undefined | null;
  remainingTimeoutMs: number;
}): ForecastView {
  const predicted = spend(args.predicted);
  const actual = spend(args.actual);
  const remainingTimeoutMs = num(args.remainingTimeoutMs);
  const remaining: ForecastSpend = {
    llmCalls: predicted.llmCalls - actual.llmCalls,
    ms: predicted.ms - actual.ms,
    cents: predicted.cents - actual.cents,
  };
  const spentLlm = predicted.llmCalls > 0 && actual.llmCalls >= predicted.llmCalls;
  const spentMs = predicted.ms > 0 && actual.ms >= predicted.ms;
  const spentCents = predicted.cents > 0 && actual.cents >= predicted.cents;
  const spent = spentLlm || spentMs || spentCents;
  // Same gate as today's guard: remainingTimeout < 0 does not count as timeout pressure.
  const timeoutPressure = predicted.ms > 0 && remainingTimeoutMs >= 0 && predicted.ms > remainingTimeoutMs;
  const overflow: ForecastOverflow = spentLlm
    ? "llmCalls"
    : spentCents
      ? "cents"
      : spentMs
        ? "ms"
        : timeoutPressure
          ? "timeout"
          : null;
  return {
    predicted,
    actual,
    remaining,
    remainingTimeoutMs,
    spent,
    timeoutPressure,
    halt: spent || timeoutPressure,
    overflow,
  };
}

/**
 * Halt copy: predicted vs actual on the overflowing dim.
 * Class token stays `budget`; this is the extra the canvas/tests print.
 */
export function forecastCopy(view: ForecastView): string {
  if (view.overflow === "timeout") {
    return `predicted ms=${view.predicted.ms} remainingTimeoutMs=${view.remainingTimeoutMs}`;
  }
  const dim: keyof ForecastSpend = view.overflow === "ms" || view.overflow === "cents" ? view.overflow : "llmCalls";
  return `predicted ${dim}=${view.predicted[dim]} actual=${view.actual[dim]}`;
}

/** True when enforce may forecast-halt. Observe/default still ignore this. */
export function forecastHalt(args: {
  predicted: Partial<ForecastSpend> | undefined | null;
  actual: Partial<ForecastSpend> | undefined | null;
  remainingTimeoutMs: number;
}): boolean {
  return remainingBudget(args).halt;
}
