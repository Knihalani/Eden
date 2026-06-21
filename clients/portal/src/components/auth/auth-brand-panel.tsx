"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  Terminal,
  GitPullRequest,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { PRODUCT_VERSION, HEALTH_REFRESH_INTERVAL_MS } from "@/lib/constants";

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
//   Gateway → Workspace → /eden-improve → Shipped PR
// Each node uses a real pipeline-stage token from globals.css so a
// palette swap on the design-system side propagates here.
const PIPELINE = [
  { id: "gateway", label: "Gateway", color: "var(--stage-executing)" },
  { id: "workspace", label: "Workspace", color: "var(--stage-refining)" },
  { id: "improve", label: "/eden-improve", color: "var(--accent)" },
  { id: "pr", label: "Shipped PR", color: "var(--stage-verifying)" },
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
    text: "/eden-improve turns failing traces into shipped PRs",
  },
];

// Footer links point at routes that are guaranteed to resolve from
// an unauthenticated session: the marketing landing page (with
// in-page anchors) and Clerk's own sign-in flow. We deliberately
// don't link to /docs, /privacy, /terms, or /status from here
// because those routes don't exist as public surfaces yet — broken
// links from the auth page would be worse than omitting them. The
// marketing landing page has its own footer for those once they
// land.
const FOOTER_LINKS = [
  { label: "Home", href: "/" },
  { label: "Pillars", href: "/#pillars" },
  { label: "Improve", href: "/#improve" },
];

/**
 * Left half of the auth split-layout. Renders the Eden wordmark,
 * a hero headline that matches the marketing landing page's
 * positioning, a four-node "closed loop" pipeline diagram that
 * visualises the Gateway → Workspace → /eden-improve → PR flow,
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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/health", {
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
      {/* Animated mesh gradient background — pure CSS */}
      <div className="auth-mesh-gradient" aria-hidden="true" />

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
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--accent-faint)] text-[var(--accent)] text-[11px] font-medium tracking-wide mb-5 border border-[var(--accent)]/20">
              <Sparkles className="w-3 h-3" />
              Observability + improvement for AI agents
            </div>

            <h1 className="auth-hero-line mb-4">
              Capture. Analyse.{" "}
              <span className="text-[var(--accent)]">Improve.</span>
            </h1>

            <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed max-w-md">
              Every LLM call through Eden&apos;s gateway, every trace queryable in your
              workspace, every regression turned into a shipped PR by{" "}
              <code className="font-mono text-[var(--text-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[13px]">
                /eden-improve
              </code>
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
                      style={{
                        background: node.color,
                        boxShadow: `0 0 10px ${node.color}80`,
                      }}
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
              <span
                className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
                style={{ background: statusColor }}
              />
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full"
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
              {FOOTER_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}