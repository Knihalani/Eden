"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  Terminal,
  GitPullRequest,
  ArrowRight,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { CodeChip } from "@/components/ui/code-chip";
import {
  PRODUCT_TAGLINE,
  PRODUCT_VERSION,
  HEALTH_REFRESH_INTERVAL_MS,
  DOCS_URL,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

type HealthState = "ok" | "degraded" | "down" | "unknown";

/**
 * Map a backend `/health` response into one of four UI states.
 * The backend returns `{ status: "healthy" | "degraded" | "unhealthy" }`
 * but we treat anything that isn't a clear 2xx with a known status as
 * `unknown` rather than alarming the user.
 */
function mapHealth(body: unknown): HealthState {
  if (!body || typeof body !== "object") return "unknown";
  const status = (body as { status?: string }).status?.toLowerCase();
  if (status === "healthy" || status === "ok") return "ok";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy" || status === "down") return "down";
  return "unknown";
}

// Pipeline nodes mirror the current product surface:
//   Gateway → Workspace → PR-suggestions → Review
// Each node uses a real pipeline-stage token from globals.css so a
// palette swap on the design-system side propagates here.
const PIPELINE = [
  { id: "gateway", label: "Gateway", color: "var(--stage-executing)" },
  { id: "workspace", label: "Workspace", color: "var(--stage-refining)" },
  { id: "improve", label: "PR-suggestions", color: "var(--accent)" },
  { id: "pr", label: "Review", color: "var(--stage-verifying)" },
] as const;

const FEATURES = [
  {
    icon: Activity,
    text: "OpenAI-compatible gateway — drop-in for any LLM",
  },
  {
    icon: Terminal,
    text: "Trace explorer + AI assistant, cited to trace IDs",
  },
  {
    icon: GitPullRequest,
    text: "Human-reviewed patch suggestions — you open the PR",
  },
];

const FOOTER_LINKS = [
  { label: "Docs", href: DOCS_URL, external: true },
  { label: "Privacy", href: "/privacy", external: false },
  { label: "Terms", href: "/terms", external: false },
];

/**
 * Left half of the auth split-layout. Renders the Eden wordmark,
 * a hero headline that matches the marketing landing page's
 * positioning, a four-node "closed loop" pipeline diagram that
 * visualises the Gateway → Workspace → PR-suggestions → Review flow,
 * three feature bullets aligned to the current pillars, a small
 * status pill, and a footer with legal links.
 *
 * Background uses three soft radial gradients that drift on a 24s
 * loop to give the panel some life without distracting from the
 * form on the right. The grid overlay is a subtle 60px blueprint
 * that ties into the rest of the dark-terminal aesthetic.
 */
export function AuthBrandPanel() {
  const [health, setHealth] = useState<HealthState>("unknown");
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // The portal doesn't expose a bare /health route — the
        // catch-all proxy at /api/proxy forwards to FastAPI's
        // /health. Calling the bare path returns Next's 404 page
        // (HTML, not JSON), which would otherwise flip the badge
        // to "Status unknown" on the auth card.
        const res = await fetch("/api/proxy/health", {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          if (!cancelled) setHealth("unknown");
          return;
        }
        const body = await res.json().catch(() => null);
        if (!cancelled) setHealth(mapHealth(body));
      } catch {
        if (!cancelled) setHealth("unknown");
      }
    };
    load();
    const id = window.setInterval(load, HEALTH_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const STATUS_LABEL: Record<HealthState, string> = {
    ok: "All systems operational",
    degraded: "Partial degradation",
    down: "Service disruption",
    unknown: "Status unknown",
  };
  const STATUS_TOKEN: Record<HealthState, string> = {
    ok: "var(--success)",
    degraded: "var(--warning)",
    down: "var(--error)",
    unknown: "var(--text-muted)",
  };
  const statusColor = STATUS_TOKEN[health];

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg-primary)]">
      {/* Mesh gradient — static when prefers-reduced-motion */}
      <div
        className="auth-mesh-gradient"
        aria-hidden="true"
        style={reduceMotion ? { animation: "none" } : undefined}
      />

      {/* Subtle grid overlay */}
      <div className="auth-grid-overlay" aria-hidden="true" />

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-between min-h-screen px-10 lg:px-14 py-10">
        {/* Top: logo */}
        <div className="flex items-center gap-3">
          <Logo size="lg" showWordmark priority href={null} />
        </div>

        {/* Middle: hero + pipeline + features */}
        <div className="flex flex-col gap-10 max-w-lg">
          {/* Hero */}
          <div>
            <p className="mb-5 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              {PRODUCT_TAGLINE}
            </p>

            <p className="auth-hero-line mb-4">
              Capture. Analyse.{" "}
              <span className="text-[var(--accent)]">Improve.</span>
            </p>

            <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed max-w-md">
              Every LLM call through Eden&apos;s gateway, every trace queryable in your
              workspace, every regression turned into a reviewable patch via{" "}
              <CodeChip size="md">trace_8a3f</CodeChip>
              .
            </p>
          </div>

          {/* Closed-loop pipeline visualizer */}
          <div className="flex flex-col gap-3">
            <p className="text-[10px] font-mono tracking-[0.18em] uppercase text-[var(--text-muted)]">
              The closed loop
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {PIPELINE.map((node, i) => (
                <div key={node.id} className="flex items-center gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="auth-pipeline-dot"
                      style={{ background: node.color }}
                    />
                    <span className="text-[12px] font-mono text-[var(--text-primary)]">
                      {node.label}
                    </span>
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <ArrowRight
                      className="w-3 h-3 text-[var(--text-faint)]"
                      aria-hidden
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Feature list */}
          <ul className="flex flex-col gap-2.5">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li
                key={text}
                className="flex items-center gap-3 text-[13.5px] text-[var(--text-secondary)]"
              >
                <span className="auth-feature-icon shrink-0">
                  <Icon className="w-3.5 h-3.5" strokeWidth={2.25} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        {/* Bottom: status badge + footer */}
        <div className="flex flex-col gap-5">
          <div
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 self-start px-2.5 py-1 rounded-full border text-[11px] font-mono"
            style={{
              background: `color-mix(in srgb, ${statusColor} 10%, transparent)`,
              borderColor: `color-mix(in srgb, ${statusColor} 25%, transparent)`,
              color: statusColor,
            }}
          >
            <span className="relative flex h-1.5 w-1.5">
              {!reduceMotion ? (
                <span
                  className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
                  style={{ background: statusColor }}
                />
              ) : null}
              <span
                className={cn("relative inline-flex h-1.5 w-1.5 rounded-full")}
                style={{ background: statusColor }}
              />
            </span>
            {STATUS_LABEL[health]}
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-[11px] text-[var(--text-muted)] font-mono">
              © {new Date().getFullYear()} Eden · {PRODUCT_VERSION}
            </p>
            <div className="flex items-center gap-4">
              {FOOTER_LINKS.map((link) =>
                link.external ? (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    {link.label}
                  </a>
                ) : (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    {link.label}
                  </Link>
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}