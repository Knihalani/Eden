import Link from "next/link";

import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SUPPORT_EMAIL } from "@/lib/constants";
import { mapHealth, type HealthState } from "@/lib/health-status";
import { marketingMetadata } from "@/lib/seo";
import { cn } from "@/lib/utils";

/**
 * Live system status, server-rendered against the backend's public
 * `/health` probe (FastAPI `HealthResponse` — src/eden/api/app.py).
 *
 * Honesty rules:
 * - Only components the probe actually reports get a row. No invented
 *   services, no fabricated uptime history (none is stored anywhere).
 * - Raw upstream strings are never rendered — the `postgres` field can
 *   carry connection-target detail on failure. We map to labels only.
 * - Backend unreachable ≠ outage claim: we show "status temporarily
 *   unavailable" and let ISR retry, rather than crash or cry wolf.
 */

export const revalidate = 60;
export const metadata = marketingMetadata({
  path: "/status",
  title: "Status · Eden",
  description:
    "Live operational status for the Eden API and its core dependencies.",
});

/** Subset of the backend `/health` body this page reads. */
type BackendHealth = {
  status?: string;
  version?: string;
  postgres?: string;
  qdrant?: string;
  redis?: string;
  ingest_decoders_ok?: boolean;
  background_workers_expected?: boolean;
  quality_worker_running?: boolean;
};

const UPSTREAM_TIMEOUT_MS = 5_000;

function apiBase(): string {
  const base = (
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8000"
  ).replace(/\/$/, "");
  // NEXT_PUBLIC_API_URL is often the relative `/api/proxy` — unusable
  // server-side. Mirror the fallback used by /api/health.
  if (base.startsWith("http") && !base.includes("/api/proxy")) return base;
  return process.env.API_INTERNAL_URL || "https://api.edenobservability.com";
}

async function fetchHealth(): Promise<BackendHealth | null> {
  try {
    const response = await fetch(`${apiBase()}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // `/health` answers HTTP 503 while soft-degraded — the JSON body is
    // authoritative, so parse it regardless of status code.
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    return body as BackendHealth;
  } catch {
    return null;
  }
}

type ComponentRow = { name: string; detail: string; state: HealthState };

/** Map probe fields → rows. Only what `/health` really reports. */
function componentRows(health: BackendHealth): ComponentRow[] {
  const rows: ComponentRow[] = [
    {
      name: "API",
      detail: "Request handling and authentication",
      // The probe answered at all, so the gateway is serving traffic.
      state: "ok",
    },
    {
      name: "Database",
      detail: "Primary datastore (Postgres)",
      state: health.postgres === "connected" ? "ok" : "down",
    },
    {
      name: "Vector search",
      detail: "Semantic retrieval (Qdrant)",
      state: health.qdrant === "connected" ? "ok" : "down",
    },
  ];

  const redis = health.redis ?? "unknown";
  if (redis !== "not_configured") {
    rows.push({
      name: "Cache & rate limiting",
      detail: "Redis",
      state:
        redis === "connected"
          ? "ok"
          : redis === "quota_exhausted" || redis.startsWith("read_only")
            ? "degraded"
            : redis === "unknown"
              ? "unknown"
              : "down",
    });
  }

  rows.push({
    name: "Ingest pipeline",
    detail: "Trace decoding and intake",
    state: health.ingest_decoders_ok === false ? "degraded" : "ok",
  });

  if (health.background_workers_expected) {
    rows.push({
      name: "Background workers",
      detail: "Scoring and evaluation loops",
      state: health.quality_worker_running ? "ok" : "degraded",
    });
  }

  return rows;
}

const STATE_META: Record<
  HealthState,
  { label: string; text: string; dot: string; banner: string }
> = {
  ok: {
    label: "Operational",
    text: "text-[var(--success)]",
    dot: "bg-[var(--success)]",
    banner: "border-[color-mix(in_srgb,var(--success)_35%,var(--line))]",
  },
  degraded: {
    label: "Degraded",
    text: "text-[var(--accent)]",
    dot: "bg-[var(--accent)]",
    banner: "border-[color-mix(in_srgb,var(--accent)_35%,var(--line))]",
  },
  down: {
    label: "Down",
    text: "text-[var(--error)]",
    dot: "bg-[var(--error)]",
    banner: "border-[color-mix(in_srgb,var(--error)_35%,var(--line))]",
  },
  unknown: {
    label: "No data",
    text: "text-[var(--text-muted)]",
    dot: "bg-[var(--text-muted)]",
    banner: "border-[var(--line)]",
  },
};

const OVERALL_COPY: Record<HealthState, { headline: string; blurb: string }> = {
  ok: {
    headline: "All systems operational",
    blurb: "Every monitored component is reporting healthy.",
  },
  degraded: {
    headline: "Degraded performance",
    blurb:
      "The platform is up, but one or more components are impaired. We are on it.",
  },
  down: {
    headline: "Service disruption",
    blurb: "Core components are failing health checks.",
  },
  unknown: {
    headline: "Status temporarily unavailable",
    blurb:
      "We could not reach the health endpoint from this page just now. That does not necessarily mean the API is down — this page re-checks every minute.",
  },
};

export default async function Page() {
  const health = await fetchHealth();
  const overall: HealthState = health ? mapHealth(health) : "unknown";
  const rows = health ? componentRows(health) : [];
  const overallMeta = STATE_META[overall];
  const copy = OVERALL_COPY[overall];
  const iso = new Date().toISOString();
  const checkedAt = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;

  return (
    <main>
      <MarketingShell
        kicker="Status"
        title="System status"
        lead="Live health of the Eden API and its core dependencies, checked directly against production."
      >
        <div className="max-w-3xl">
          <div
            className={cn(
              "flex items-start gap-3.5 border bg-[var(--bg-inset)] p-5 sm:p-6",
              overallMeta.banner,
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                overallMeta.dot,
              )}
            />
            <div>
              <p
                className={cn(
                  "text-[1.0625rem] font-semibold tracking-[-0.01em]",
                  overallMeta.text,
                )}
              >
                {copy.headline}
              </p>
              <p className="mt-1 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                {copy.blurb}
              </p>
            </div>
          </div>

          {rows.length > 0 ? (
            <div className="mt-8 flex flex-col gap-px border border-[var(--line)] bg-[var(--line)]">
              {rows.map((row) => {
                const meta = STATE_META[row.state];
                return (
                  <div
                    key={row.name}
                    className="flex items-center justify-between gap-4 bg-[var(--bg)] px-5 py-4"
                  >
                    <div>
                      <p className="text-[0.9375rem] font-medium text-[var(--text)]">
                        {row.name}
                      </p>
                      <p className="mt-0.5 type-meta text-[var(--text-faint)]">
                        {row.detail}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em]",
                        meta.text,
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn("size-1.5 rounded-full", meta.dot)}
                      />
                      {meta.label}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          <p className="mt-6 type-meta text-[var(--text-faint)]">
            Checked {checkedAt} UTC · re-checked every 60 seconds.
            {health?.version ? ` API version ${health.version}.` : ""}
          </p>

          <div className="mt-10 space-y-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
            <p>
              Seeing something this page does not?{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
              >
                {SUPPORT_EMAIL}
              </a>{" "}
              — we respond as quickly as we can.
            </p>
            <p className="pt-2">
              <Link href="/" className="ds-link type-ui">
                ← Home
              </Link>
            </p>
          </div>
        </div>
      </MarketingShell>
    </main>
  );
}
