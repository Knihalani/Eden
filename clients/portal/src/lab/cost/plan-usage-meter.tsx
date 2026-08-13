"use client";
/**
 * PlanUsageMeter — current-period usage vs plan limits (OOM W3-4).
 *
 * Shows credits, tokens, and seats consumption as labelled progress bars.
 * Soft-cap warning (amber) fires at the soft limit; hard-cap (red) at the
 * hard limit.  Renders nothing when ``planLimits`` is null (billing off or
 * still loading) so callers need no conditional wrapper.
 */
import { type PlanLimitsPayload } from "@/lib/api/budget";

// ── helpers ──────────────────────────────────────────────────────────────────

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function barColor(status: string | undefined): string {
  if (status === "hard_exceeded") return "var(--color-danger, #ef4444)";
  if (status === "soft_exceeded") return "var(--color-warning, #f59e0b)";
  return "var(--color-accent, #6366f1)";
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// ── sub-component ─────────────────────────────────────────────────────────────

function MeterRow({
  label,
  used,
  hardLimit,
  softLimit,
  status,
  formatValue = (v) => String(Math.round(v)),
}: {
  label: string;
  used: number;
  hardLimit: number;
  softLimit?: number;
  status?: string;
  formatValue?: (v: number) => string;
}) {
  if (hardLimit <= 0) return null; // uncapped (enterprise)
  const p = pct(used, hardLimit);
  const color = barColor(status);
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.75rem",
          marginBottom: "0.25rem",
          color: "var(--text-secondary)",
        }}
      >
        <span>{label}</span>
        <span>
          {formatValue(used)} / {formatValue(hardLimit)}
          {softLimit != null && softLimit > 0 && softLimit < hardLimit && (
            <span style={{ color: "var(--text-muted)", marginLeft: "0.25rem" }}>
              (soft {formatValue(softLimit)})
            </span>
          )}
        </span>
      </div>
      <div
        style={{
          height: "6px",
          borderRadius: "3px",
          background: "var(--surface-muted, rgba(0,0,0,0.08))",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${p}%`,
            background: color,
            borderRadius: "3px",
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function PlanUsageMeter({
  planLimits,
}: {
  planLimits: PlanLimitsPayload | null | undefined;
}) {
  if (!planLimits) return null;

  const creditsUsed = planLimits.credits_used ?? 0;
  const creditsSoft = planLimits.credits_soft_limit ?? 0;
  const creditsHard = planLimits.credits_hard_limit ?? 0;
  const tokensUsed = planLimits.tokens_used ?? 0;
  const seatsUsed = planLimits.seats_used ?? 0;
  const seatsHard = planLimits.seats_limit ?? 0;

  const hasAnyMeter = creditsHard > 0 || seatsHard > 0;
  if (!hasAnyMeter) return null;

  return (
    <section
      aria-label="Plan usage"
      style={{
        padding: "1rem",
        borderRadius: "0.5rem",
        border: "1px solid var(--border-subtle, rgba(0,0,0,0.08))",
        background: "var(--surface-raised, var(--surface))",
        marginBottom: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.75rem",
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: "0.8125rem",
            color: "var(--text-primary)",
          }}
        >
          {planLimits.display_name ?? planLimits.plan_name} plan · this month
        </span>
        {planLimits.credits_status === "hard_exceeded" && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "var(--color-danger, #ef4444)",
              fontWeight: 500,
            }}
          >
            Limit reached
          </span>
        )}
        {planLimits.credits_status === "soft_exceeded" && (
          <span
            style={{
              fontSize: "0.75rem",
              color: "var(--color-warning, #f59e0b)",
              fontWeight: 500,
            }}
          >
            Approaching limit
          </span>
        )}
      </div>

      {creditsHard > 0 && (
        <MeterRow
          label="Credits (100 cr = $1)"
          used={creditsUsed}
          softLimit={creditsSoft}
          hardLimit={creditsHard}
          status={planLimits.credits_status}
          formatValue={formatNum}
        />
      )}

      {tokensUsed > 0 && (
        <MeterRow
          label="Tokens"
          used={tokensUsed}
          hardLimit={planLimits.credits_hard_limit ? planLimits.credits_hard_limit * 50_000 : 0}
          formatValue={formatNum}
        />
      )}

      {seatsHard > 0 && (
        <MeterRow
          label="Seats"
          used={seatsUsed}
          hardLimit={seatsHard}
          formatValue={(v) => String(Math.round(v))}
        />
      )}
    </section>
  );
}
