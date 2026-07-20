import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  XCircle,
} from "lucide-react";
import { LegalPage } from "@/components/layout/legal-page";
import {
  mapHealthResponse,
  type HealthState,
} from "@/lib/health-status";
import { forwardToBackend } from "@/lib/proxy";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Status · Eden",
  description:
    "Public Eden API health — operational, degraded, or disrupted. No portal login required.",
  robots: { index: true, follow: true },
};

/** Always revalidate against live backend health — never ship a stale “ok”. */
export const dynamic = "force-dynamic";

type ComponentTone = "ok" | "degraded" | "down" | "neutral";

const STATE_COPY: Record<
  HealthState,
  {
    label: string;
    detail: string;
    chip: string;
    token: string;
    bg: string;
    border: string;
    Icon: typeof CheckCircle2;
  }
> = {
  ok: {
    label: "All systems operational",
    chip: "Operational",
    detail: "Core API dependencies are responding normally.",
    token: "var(--success)",
    bg: "var(--success-bg)",
    border: "color-mix(in srgb, var(--success) 35%, transparent)",
    Icon: CheckCircle2,
  },
  degraded: {
    label: "Partial degradation",
    chip: "Degraded",
    detail:
      "The API is up, but a soft dependency is unhealthy. Product flows that need that dependency may be limited — this page will not show green.",
    token: "var(--warning)",
    bg: "var(--warning-bg)",
    border: "color-mix(in srgb, var(--warning) 40%, transparent)",
    Icon: AlertTriangle,
  },
  down: {
    label: "Service disruption",
    chip: "Down",
    detail: "The health probe could not confirm a healthy API. Retry shortly.",
    token: "var(--error)",
    bg: "var(--error-bg)",
    border: "color-mix(in srgb, var(--error) 40%, transparent)",
    Icon: XCircle,
  },
  unknown: {
    label: "Status unknown",
    chip: "Unknown",
    detail: "The health probe did not return a recognizable payload.",
    token: "var(--text-muted)",
    bg: "var(--bg-primary)",
    border: "var(--border-default)",
    Icon: CircleHelp,
  },
};

const LEGEND: Array<{
  state: Exclude<HealthState, "unknown">;
  title: string;
  blurb: string;
}> = [
  {
    state: "ok",
    title: "Operational",
    blurb: "Healthy body.status — green only here.",
  },
  {
    state: "degraded",
    title: "Degraded",
    blurb: "HTTP may be 200; UI stays amber.",
  },
  {
    state: "down",
    title: "Down",
    blurb: "Unreachable or unhealthy probe.",
  },
];

type HealthBody = {
  status?: string;
  version?: string;
  postgres?: string;
  qdrant?: string;
  quality_worker_running?: boolean;
  request_id?: string;
};

async function loadHealth(): Promise<{
  state: HealthState;
  httpStatus: number;
  body: HealthBody | null;
}> {
  try {
    const response = await forwardToBackend("/health", { method: "GET" });
    const body = (await response.json().catch(() => null)) as HealthBody | null;
    return {
      state: mapHealthResponse(response.status, body),
      httpStatus: response.status,
      body,
    };
  } catch {
    return { state: "down", httpStatus: 0, body: null };
  }
}

function toneForValue(value: string): ComponentTone {
  const lower = value.toLowerCase();
  if (
    lower === "connected" ||
    lower === "ok" ||
    lower === "healthy" ||
    lower === "true"
  ) {
    return "ok";
  }
  if (lower === "degraded" || lower.includes("error") || lower === "false") {
    return "degraded";
  }
  if (
    lower === "down" ||
    lower === "unhealthy" ||
    lower === "unreachable" ||
    lower === "disconnected"
  ) {
    return "down";
  }
  return "neutral";
}

const TONE_COLOR: Record<ComponentTone, string> = {
  ok: "var(--success)",
  degraded: "var(--warning)",
  down: "var(--error)",
  neutral: "var(--text-secondary)",
};

function ComponentRow({
  name,
  value,
}: {
  name: string;
  value: string;
}) {
  const tone = toneForValue(value);
  return (
    <div className="flex flex-col gap-1.5 py-3.5 border-b border-[var(--border-subtle)] last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-sm text-[var(--text-secondary)] shrink-0">{name}</span>
      <span
        className="text-sm font-mono break-all sm:text-right sm:max-w-[65%]"
        style={{ color: TONE_COLOR[tone] }}
      >
        {value}
      </span>
    </div>
  );
}

export default async function StatusPage() {
  const { state, httpStatus, body } = await loadHealth();
  const copy = STATE_COPY[state];
  const StatusIcon = copy.Icon;
  const checkedAt = new Date().toISOString();
  const bodyStatus = body?.status ?? "n/a";
  const isHonestNonGreen = state === "degraded" || state === "down";

  return (
    <LegalPage
      eyebrow="Trust Center"
      title="System status"
      description="Live probe of Eden’s public API health. This page never sits behind portal chrome — what you see here is what uptime monitors should parse from /api/health."
      size="narrow"
    >
      <div className="space-y-10">
        {/* Primary status banner — tinted by state, never green when degraded */}
        <div
          className="rounded-xl border p-5 sm:p-6"
          style={{ background: copy.bg, borderColor: copy.border }}
          role="status"
          aria-live="polite"
          data-health-state={state}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex items-start gap-3 min-w-0">
              <span
                className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                style={{
                  color: copy.token,
                  borderColor: copy.border,
                  background: "color-mix(in srgb, var(--bg-primary) 55%, transparent)",
                }}
                aria-hidden
              >
                <StatusIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-[0.14em] border"
                    style={{
                      color: copy.token,
                      borderColor: copy.border,
                      background: "color-mix(in srgb, var(--bg-primary) 40%, transparent)",
                    }}
                  >
                    <span
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        state === "ok" && "animate-pulse",
                      )}
                      style={{ background: copy.token }}
                      aria-hidden
                    />
                    {copy.chip}
                  </span>
                  {isHonestNonGreen && (
                    <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--text-muted)]">
                      not operational
                    </span>
                  )}
                </div>
                <h2 className="text-lg sm:text-xl font-semibold text-[var(--text-primary)] tracking-tight">
                  {copy.label}
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                  {copy.detail}
                </p>
              </div>
            </div>
          </div>

          <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 border-t pt-4"
            style={{ borderColor: copy.border }}
          >
            <div>
              <dt className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)] mb-1">
                body.status
              </dt>
              <dd className="font-mono text-sm text-[var(--text-primary)] break-all">
                {bodyStatus}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)] mb-1">
                Probe HTTP
              </dt>
              <dd className="font-mono text-sm text-[var(--text-primary)]">
                {httpStatus || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--text-muted)] mb-1">
                Checked
              </dt>
              <dd className="font-mono text-[11px] sm:text-sm text-[var(--text-secondary)] break-all">
                {checkedAt}
              </dd>
            </div>
          </dl>
        </div>

        {/* How to read states — keeps degraded ≠ green explicit */}
        <section aria-labelledby="status-legend">
          <h3
            id="status-legend"
            className="text-xs font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] mb-3"
          >
            How to read this page
          </h3>
          <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {LEGEND.map((item) => {
              const meta = STATE_COPY[item.state];
              return (
                <li
                  key={item.state}
                  className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{ background: meta.token }}
                      aria-hidden
                    />
                    <span
                      className="text-xs font-semibold"
                      style={{ color: meta.token }}
                    >
                      {item.title}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                    {item.blurb}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Component breakdown */}
        <section aria-labelledby="status-components">
          <h3
            id="status-components"
            className="text-xs font-mono font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)] mb-3"
          >
            Components
          </h3>
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] px-4 sm:px-5">
            <ComponentRow
              name="API overall"
              value={
                body?.status ?? (state === "down" ? "unreachable" : "unknown")
              }
            />
            <ComponentRow name="Postgres" value={body?.postgres ?? "unknown"} />
            <ComponentRow name="Qdrant" value={body?.qdrant ?? "unknown"} />
            {typeof body?.quality_worker_running === "boolean" && (
              <ComponentRow
                name="Quality worker"
                value={String(body.quality_worker_running)}
              />
            )}
            {body?.version && (
              <ComponentRow name="API version" value={body.version} />
            )}
          </div>
        </section>

        {/* Machine-readable probe — link without implying green */}
        <section
          className="rounded-xl border border-[var(--accent)]/30 bg-[var(--bg-primary)] p-5 sm:p-6"
          aria-labelledby="status-probe"
        >
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[var(--accent-faint)] border border-[var(--accent)]/20 flex items-center justify-center text-[var(--accent)] shrink-0">
              <Activity className="w-4 h-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h3
                id="status-probe"
                className="text-base font-semibold text-[var(--text-primary)] mb-1 tracking-tight"
              >
                Machine-readable probe
              </h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4">
                Parse{" "}
                <code className="font-mono text-[13px] text-[var(--text-primary)]">
                  body.status
                </code>
                , not HTTP alone. Soft degradation can keep{" "}
                <code className="font-mono text-[13px] text-[var(--text-primary)]">
                  HTTP 200
                </code>{" "}
                with{" "}
                <code className="font-mono text-[13px] text-[var(--warning)]">
                  status: &quot;degraded&quot;
                </code>
                — monitors that only check status codes stay green; this page
                stays amber. Hard failures still return 503.
              </p>
              <Link
                href="/api/health"
                className="inline-flex items-center gap-2 min-h-11 px-4 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] hover:border-[var(--border-strong)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="font-mono">/api/health</span>
                <ExternalLink className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
                <span className="sr-only">Open API health JSON</span>
              </Link>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/security"
            className="inline-flex items-center gap-1.5 min-h-11 px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Security
          </Link>
          <Link
            href="/contact"
            className="inline-flex items-center gap-1.5 min-h-11 px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Contact
          </Link>
        </div>
      </div>
    </LegalPage>
  );
}
