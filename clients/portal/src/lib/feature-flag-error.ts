/**
 * Honest UX when feature-gated routes (intelligence_gap_v0,
 * change_impact_preview_v1, etc.) return 404/503 while the flag is off.
 * Backend ``require_feature_flag`` raises HTTP 404 with detail
 * ``"Not Found"`` — callers on gated surfaces should not paint that as
 * a generic outage. Bare 404/503 (empty resources, repo gaps) must not
 * be treated as flag-off.
 *
 * Also maps HTTP 501 / ``not_implemented`` envelopes to clear
 * "Not available yet" copy so Optimize/Guardrails surfaces never
 * paint stub backends as empty success.
 *
 * Billing free-only: Stripe paid endpoints intentionally return 503 with
 * ``Paid plans are not available yet`` — treat as expected dormancy, not
 * an integration outage or retryable ErrorState.
 */

import { ApiError } from "@/lib/api";

export const FEATURE_NOT_ENABLED_TITLE = "Feature not enabled";

export const FEATURE_NOT_ENABLED_MESSAGE =
  "This capability is turned off for this environment. Ask an admin to enable it in Settings.";

export const NOT_IMPLEMENTED_TITLE = "Not available yet";

export const NOT_IMPLEMENTED_MESSAGE =
  "This capability is not implemented in this environment yet.";

export const PAID_PLANS_DISABLED_TITLE = "Paid plans not available yet";

export const PAID_PLANS_DISABLED_MESSAGE =
  "Eden is currently free-only. Usage caps still apply; Stripe checkout is not open yet.";

function statusOf(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

/** Raw upstream detail / code for machine matching (not sanitized UI copy). */
function signalBlob(err: unknown): string {
  if (err instanceof ApiError) {
    return [err.detail, err.code, err.message].filter(Boolean).join(" ");
  }
  if (typeof err === "object" && err !== null) {
    const o = err as { detail?: unknown; code?: unknown; message?: unknown };
    return [o.detail, o.code, o.message]
      .map((v) => (typeof v === "string" ? v : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

const FLAG_OFF_SIGNAL =
  /^(Not Found)$|feature_?flag|feature_disabled|flag_off|disabled for this org|improvement_agent_v1|FEATURE_NOT/i;

const NON_FLAG_SIGNAL =
  /repo_not_connected|Connect GitHub App|No GitHub repo connected/i;

const NOT_IMPLEMENTED_SIGNAL =
  /\bnot[_ ]?implemented\b|implementation pending|Stub registered/i;

/** Matches billing.py ``_require_paid_plans_enabled`` free-only 503 detail. */
const PAID_PLANS_DISABLED_SIGNAL =
  /paid plans are not available|currently free-?only|eden is currently free/i;

/**
 * True when Stripe paid endpoints intentionally 503 in free-only mode
 * (``PAID_PLANS_ENABLED = False``). Distinct from Stripe-not-configured.
 */
export function isPaidPlansDisabledError(err: unknown): boolean {
  if (statusOf(err) !== 503) return false;
  return PAID_PLANS_DISABLED_SIGNAL.test(signalBlob(err));
}

/**
 * True when the error carries an explicit flag-off signal.
 * Requires 404/503 *and* a require_feature_flag / kill-switch detail —
 * not every missing resource or upstream gap.
 */
export function isFeatureFlagOffError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== 404 && status !== 503) return false;
  const blob = signalBlob(err);
  if (!blob) return false;
  if (NON_FLAG_SIGNAL.test(blob)) return false;
  // require_feature_flag uses exact detail "Not Found"
  if (err instanceof ApiError && /^Not Found$/i.test(err.detail.trim())) {
    return true;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "detail" in err &&
    typeof (err as { detail?: unknown }).detail === "string" &&
    /^(Not Found)$/i.test((err as { detail: string }).detail.trim())
  ) {
    return true;
  }
  return FLAG_OFF_SIGNAL.test(blob);
}

/** True for HTTP 501 or intelligence stub / not_implemented signals. */
export function isNotImplementedError(err: unknown): boolean {
  if (statusOf(err) === 501) return true;
  return NOT_IMPLEMENTED_SIGNAL.test(signalBlob(err));
}

/**
 * Unwrap Cat 11/13/15 ``_ok_envelope`` payloads. Non-ok status
 * (including ``not_implemented``) throws so callers surface ErrorState
 * instead of a false-empty table.
 */
export function assertOkEnvelope<T>(
  env: { status?: string; message?: string; data?: T | null },
  fallback: string,
): T {
  const status = env.status ?? "ok";
  if (status !== "ok" && status !== "ok_fallback") {
    throw new Error(
      env.message?.trim() ||
        (status === "not_implemented"
          ? "Stub registered; implementation pending"
          : fallback),
    );
  }
  if (env.data == null) {
    throw new Error(fallback);
  }
  return env.data;
}

/** ErrorState title + message for a gated-surface failure. */
export function featureGatedErrorCopy(
  err: unknown,
  fallbackTitle: string,
): { title: string; message: string } {
  if (isPaidPlansDisabledError(err)) {
    return {
      title: PAID_PLANS_DISABLED_TITLE,
      message: PAID_PLANS_DISABLED_MESSAGE,
    };
  }
  if (isFeatureFlagOffError(err)) {
    return {
      title: FEATURE_NOT_ENABLED_TITLE,
      message: FEATURE_NOT_ENABLED_MESSAGE,
    };
  }
  if (isNotImplementedError(err)) {
    return {
      title: NOT_IMPLEMENTED_TITLE,
      message: NOT_IMPLEMENTED_MESSAGE,
    };
  }
  return {
    title: fallbackTitle,
    message: err instanceof Error ? err.message : String(err ?? fallbackTitle),
  };
}

/** Banner / toast string for catch blocks on gated surfaces. */
export function featureGatedMessage(err: unknown, fallback: string): string {
  if (isPaidPlansDisabledError(err)) return PAID_PLANS_DISABLED_TITLE;
  if (isFeatureFlagOffError(err)) return FEATURE_NOT_ENABLED_TITLE;
  if (isNotImplementedError(err)) return NOT_IMPLEMENTED_TITLE;
  return err instanceof Error ? err.message : fallback;
}

/** Flag-off, free-only paid dormancy, and 501 stubs are not fixed by retry. */
export function isRetryableIntelligenceError(err: unknown): boolean {
  return (
    !isPaidPlansDisabledError(err) &&
    !isFeatureFlagOffError(err) &&
    !isNotImplementedError(err)
  );
}
