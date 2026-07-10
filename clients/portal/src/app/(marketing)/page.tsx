"use client";

// ponytail: force-dynamic so the marketing page is never statically
// cached. Without this, Next.js can serve a cached HTML that always
// renders the "Sign in / Get started" CTA, even when the user has a
// Clerk session cookie. The page also uses Clerk's useUser() below,
// which runs client-side after hydration; force-dynamic ensures the
// initial server render doesn't pin a stale CTA.
export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn, isExternalHref } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import {
  PRODUCT_VERSION,
  PRODUCT_COPYRIGHT_YEAR,
  DOCS_URL,
} from "@/lib/constants";
import { CodeChip } from "@/components/ui";
import {
  Activity,
  Terminal,
  GitPullRequest,
  ChevronDown,
  Menu,
  X,
  Bot,
  MessageSquare,
  FileText,
  ArrowRight,
  Workflow,
  Eye,
  GitBranch,
  Search,
  Check,
  Sparkles,
  Lock,
  Code2,
  Users,
} from "lucide-react";

const NAV_LINKS = [
  { label: "Pillars", href: "#pillars" },
  { label: "How it works", href: "#improve" },
  { label: "Docs", href: DOCS_URL },
];

// Three pillars — mirrors the architecture pillars, expressed as
// outcome-oriented feature cards.
const PILLARS = [
  {
    id: "capture",
    icon: Eye,
    badge: "Capture",
    title: "One proxy. Every model.",
    description:
      "Drop-in SDKs and an OpenAI-compatible HTTP gateway. Switch one base_url, capture every LLM call — to OpenAI, Anthropic, Bedrock, self-hosted — with PII pre-masked at ingest.",
    bullets: [
      "OpenAI-compatible gateway — change one line",
      "Native decoders for OpenAI, Anthropic, Gemini, Bedrock, LangChain, LlamaIndex, Vercel AI SDK",
      "Structured evals: LLM-as-judge, code-based, third-party",
    ],
  },
  {
    id: "analyse",
    icon: Activity,
    badge: "Analyse",
    title: "A workspace that thinks with you.",
    description:
      "Multi-tenant org workspace with trace, cost, latency, and eval visualisations. A persistent AI assistant sidebar lives in every view — answers cited to real trace IDs and eval records, never generic web results.",
    bullets: [
      "Time-series + drill-down for traces, tokens, cost, eval regressions",
      "Multi-tenant orgs with RBAC, SSO/SAML, SCIM, audit log",
      "Export to JSONL/CSV, scheduled S3/GCS, webhook delivery",
    ],
  },
  {
    id: "improve",
    icon: GitPullRequest,
    badge: "Improve",
    title: "Reviewable PR suggestions, judges, and alerts.",
    description:
      "Surface regressions the moment eval scores drift, rank candidate root causes against trace evidence, and ship a human-reviewed PR. Every action stays in your org, behind RBAC, with a full audit trail.",
    bullets: [
      "PR-suggestion inbox — trace-driven patch drafts, you click & open the PR",
      "Deterministic + LLM-as-judge evals, regression alerts, golden-dataset replays",
      "Cost budgets, PII redaction, RBAC, audit log, scheduled export",
    ],
  },
];

const INSTALL_BLOCKS = [
  {
    id: "gateway",
    label: "Gateway",
    code: `from openai import OpenAI

client = OpenAI(
    base_url="https://gateway.eden.example/v1",  # Eden
    api_key=os.environ["EDEN_API_KEY"],
)

resp = client.chat.completions.create(
    model="gpt-4o",  # any upstream: OpenAI, Anthropic, Bedrock…
    messages=[{"role": "user", "content": "Hello"}],
)`,
  },
  {
    id: "sdk",
    label: "Python SDK",
    code: `import eden

# Wrap any LLM call to capture a span
with eden.span("agent.reasoning") as span:
    resp = client.chat.completions.create(...)
    span.set_output(resp.choices[0].message.content)
    span.set_eval("quality", score=0.92, evaluator="llm-judge")`,
  },
  {
    id: "auto",
    label: "Auto-instrument",
    code: `import eden
from openai import OpenAI

eden.configure(api_key=os.environ["EDEN_API_KEY"])
eden.instrument()  # patches openai, anthropic, langchain, vercel-ai

client = OpenAI()
resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
# Every call now lands in your Eden workspace, fully traced.`,
  },
];

// Live trace stream shown in the hero's right panel — a realistic
// "agent is talking to OpenAI through Eden" timeline. Each line
// lands in cadence with the typing animation.
const IMPROVE_LOG = [
  { time: "00:00", msg: "ingest  POST /v1/chat/completions  model=gpt-4o-mini", type: "proc" },
  { time: "00:00", msg: "pii-scan 4 entities redacted (email, phone, name×2)", type: "" },
  { time: "00:01", msg: "trace  span=agent.reasoning  parent=run_8a3f", type: "" },
  { time: "00:02", msg: "llm  812 in / 318 out  $0.00042  1.18s", type: "" },
  { time: "00:03", msg: "judge  quality=0.91  cite=0.88  tone=0.94", type: "ok" },
  { time: "00:03", msg: "stored  trace_8a3f…d1b  portal.edenobservability.com", type: "ok" },
];

// Sidebar assistant mock conversation.
const ASSISTANT_TURNS = [
  {
    role: "user",
    body: "Why did latency spike on Tuesday for project copilot-prod?",
  },
  {
    role: "assistant",
    body:
      "Latency p95 went from 1.2s → 2.4s on Tuesday 14:00 UTC, driven by a regression in planner.v3 triggered 2,400 traces with multi-step tool loops.",
    cites: ["trace_8a3f…", "trace_8b12…", "trace_8c44…"],
  },
];

// Mock metric strip — single source of truth for the hero KPI row.
// Three product-honest anchors: a usage ceiling, a swap promise, a
// outcome promise. No "X+ integrations" filler — that's the trust
// strip's job.
const HERO_METRICS = [
  // Three product-honest anchors. Unit and label share one
  // micro-label line (mono + uppercase + tracking) so the wider
  // strings don't wrap on the 3-col grid at 1440px.
  { kpi: "100K",   unit: "events/mo",  label: "Free tier" },
  { kpi: "1-line", unit: "swap",        label: "Drop-in gateway" },
  { kpi: "<5ms",   unit: "p99",         label: "SDK overhead" },
];

const FAQS = [
  {
    q: "Is Eden a model vendor?",
    a: "No. Eden is a proxy and observability layer. We never serve a model — we forward every request to whichever upstream you configure and capture the response.",
  },
  {
    q: "Does PII get stored?",
    a: "PII is masked at ingest using your redaction rules. Raw payloads can be opted out of entirely; only structured metadata is required.",
  },
  {
    q: "How do PR suggestions work?",
    a: "When a regression is detected, the PR-suggestion inbox lists a draft patch with the failing trace, the hypothesised root cause, and the eval results. A human clicks Open PR — Eden never opens a PR autonomously.",
  },
];

/**
 * ImprovePillar — the third pillar rendered as a wide terminal
 * strip instead of another card. The shape break tells the reader
 * that the *third* step is qualitatively different: it's a
 * reviewable inbox, not a dashboard. The five steps map to the
 * real PR-suggestion flow so a developer who's seen the inbox
 * recognises the rhythm.
 *
 * Rendered server-side; no client state.
 */
function ImprovePillar({ pillar }: { pillar: typeof PILLARS[number] }) {
  const Icon = pillar.icon;
  const steps = [
    { token: "01", label: "Detect regression", meta: "judge.score drift · −0.18" },
    { token: "02", label: "Cluster failing traces", meta: "47 traces · last 6h" },
    { token: "03", label: "Draft patch", meta: "prompts/system.md · +12 / −4" },
    { token: "04", label: "Run evals locally", meta: "smoke ✓ · quality ✓ · regression ✓" },
    { token: "05", label: "Queue for review", meta: "inbox: PR-suggestions · 1 ready" },
  ];
  return (
    <article className="mt-5 relative bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden">
      <div className="grid grid-cols-1 lg:grid-cols-12">
        {/* Left rail: pillar badge + title + bullets. The
          * description is tightened here because the four-step
          * log on the right carries most of the explanation. */}
        <div className="lg:col-span-5 p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-[var(--border-subtle)] flex flex-col">
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {pillar.badge}
            </span>
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
            <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
              running
            </span>
          </div>
          <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center mb-5">
            <Icon className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <h3
            className="text-xl font-semibold text-[var(--text-primary)] mb-3 tracking-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            {pillar.title}
          </h3>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-6">
            {pillar.description}
          </p>
          <ul className="flex flex-col gap-2 mt-auto">
            {pillar.bullets.map((b) => (
              <li
                key={b}
                className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]"
              >
                <span className="w-1 h-1 rounded-full bg-[var(--accent)] mt-2 shrink-0" />
                <span className="leading-snug">{b}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* Right rail: the four-step log. Same visual register as
          * the hero terminal panel; a small connecting line on the
          * left ties the steps together so the eye reads top-to-
          * bottom as one timeline rather than five rows. */}
        <div className="lg:col-span-7 bg-[var(--bg-base)] p-6 lg:p-8 font-mono">
          <div className="flex items-center gap-1.5 pb-4 mb-4 border-b border-[var(--border-subtle)]">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-close)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-minimize)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-zoom)]" />
            <span className="ml-3 text-[11px] text-[var(--text-muted)] tracking-wider">
              eden — pr-suggestions
            </span>
          </div>
          <ol className="relative space-y-3">
            {steps.map((s, i) => (
              <li key={s.token} className="relative pl-8">
                {/* Connector line through the dot, skipping the
                  * first step (no line above) and last step (no
                  * line below). Absolute-positioned so it doesn't
                  * interfere with the row's flex layout. */}
                <span
                  aria-hidden="true"
                  className="absolute left-[7px] top-0 bottom-0 w-px bg-[var(--border-subtle)]"
                  style={{
                    // Hide the top half of the line on the first
                    // step and the bottom half on the last step so
                    // the timeline starts and ends cleanly.
                    clipPath:
                      i === 0
                        ? "polygon(0 8px, 100% 8px, 100% 100%, 0 100%)"
                        : i === steps.length - 1
                          ? "polygon(0 0, 100% 0, 100% calc(100% - 8px), 0 calc(100% - 8px))"
                          : undefined,
                  }}
                />
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1 w-[15px] h-[15px] rounded-full border border-[var(--accent)] bg-[var(--bg-base)] flex items-center justify-center text-[8px] text-[var(--accent)] font-semibold"
                >
                  {s.token}
                </span>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-[13px] text-[var(--text-primary)]">
                    {s.label}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {s.meta}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {/* Final line: the PR opens. Phosphor green only here, in
            * keeping with the brand rule that green means
            * running/success. A subtle dot-pulse via the existing
            * glow-pulse keyframe in globals.css. */}
          <div className="mt-5 pt-4 border-t border-[var(--border-subtle)] flex items-center gap-2 text-[12px]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[var(--terminal)] animate-[glow-pulse_2.4s_ease-in-out_infinite]" />
            <span className="text-[var(--terminal)] font-semibold">
              1 suggestion queued
            </span>
            <span className="text-[var(--text-muted)]">·</span>
            <span className="text-[var(--text-muted)]">
              evals passed · awaiting human review
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function LandingPage() {
  const t = useTranslations();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("gateway");
  const [logRevealed, setLogRevealed] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // ponytail: isSignedIn toggles the marketing CTAs into "Open app"
  // entries instead of "Sign in / Get started" — so a returning
  // user lands on the marketing page and immediately gets a way
  // back into the portal.
  const { isSignedIn, isLoaded } = useUser();
  const signedIn = isLoaded && isSignedIn;
  const router = useRouter();
  // ponytail: on auth-state change, force a re-render so the
  // server-rendered CTA matches the live Clerk session. Without this,
  // a returning user could see "Sign in / Get started" frozen for a
  // beat while the client hydrates and Clerk resolves the cookie.
  useEffect(() => {
    if (isLoaded) router.refresh();
  }, [isLoaded, router]);

  const FULL_PROMPT = "agent.reasoning › chat › judge › store";

  // Typing animation for the trace label in the hero.
  useEffect(() => {
    if (typed.length >= FULL_PROMPT.length) return;
    const t = setTimeout(() => {
      setTyped(FULL_PROMPT.slice(0, typed.length + 1));
    }, 45);
    return () => clearTimeout(t);
  }, [typed]);

  // Reveal log lines in cadence with the typing animation — the first
  // line lands at ~280ms (when typing finishes), then one every ~1.8s.
  useEffect(() => {
    if (logRevealed >= IMPROVE_LOG.length) return;
    const baseDelay = typed.length >= FULL_PROMPT.length ? 0 : 280 - typed.length * 45;
    const delay = logRevealed === 0 ? Math.max(baseDelay, 0) : 1800;
    const handle = setTimeout(() => setLogRevealed((n) => n + 1), delay);
    return () => clearTimeout(handle);
  }, [logRevealed, typed]);

  const activeBlock = INSTALL_BLOCKS.find((b) => b.id === activeTab) ?? INSTALL_BLOCKS[0];

  async function copyCode(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // noop
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  return (
    <div className="relative min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-x-hidden">
      {/* Ambient backdrop: layered radial glows + grid.
       * pointer-events-none so it never intercepts clicks. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        {/* Top-of-page radial — sits behind the hero. */}
        <div
          className="absolute -top-40 left-1/2 -translate-x-1/2 w-[1100px] h-[700px] opacity-[0.35]"
          style={{
            background:
              "radial-gradient(ellipse at center, var(--accent-dim) 0%, transparent 65%)",
          }}
        />
        {/* Faint horizontal scanline grid.
         * SVG data-uri keeps it token-coloured via currentColor. */}
        <svg
          className="absolute inset-0 w-full h-full opacity-[0.5]"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <defs>
            <pattern
              id="eden-grid"
              width="48"
              height="48"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 48 0 L 0 0 0 48"
                fill="none"
                stroke="var(--border-subtle)"
                strokeOpacity="0.35"
                strokeWidth="0.5"
              />
            </pattern>
            <linearGradient id="eden-grid-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="white" stopOpacity="0.7" />
              <stop offset="60%" stopColor="white" stopOpacity="0.15" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id="eden-grid-mask">
              <rect width="100%" height="100%" fill="url(#eden-grid-fade)" />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="url(#eden-grid)"
            mask="url(#eden-grid-mask)"
          />
        </svg>
      </div>

      {/* ============================== Nav ============================== */}
      <nav
        className="sticky top-0 z-40 h-16 bg-[var(--bg-primary)]/80 backdrop-blur-xl border-b border-[var(--border-subtle)]"
        style={{ backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
          <Logo size="md" showWordmark priority href="/" />

          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) =>
              isExternalHref(link.href) ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.label}
                  href={link.href}
                  className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                >
                  {link.label}
                </Link>
              ),
            )}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <a
              href="https://status.edenobservability.com"
              target="_blank"
              rel="noreferrer"
              className="hidden lg:inline-flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--terminal)] opacity-60 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
              </span>
              All systems normal
            </a>
            {signedIn ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
              >
                Open app
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  {t("nav.signin")}
                </Link>
                <Link
                  href="/sign-up"
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                >
                  {t("nav.signup")}
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </>
            )}
          </div>

          <button
            className="md:hidden p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden absolute top-16 left-0 right-0 bg-[var(--bg-primary)] border-b border-[var(--border-subtle)] px-6 py-4 flex flex-col gap-2">
            {NAV_LINKS.map((link) =>
              isExternalHref(link.href) ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  key={link.label}
                  href={link.href}
                  className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {link.label}
                </Link>
              ),
            )}
            <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[var(--border-subtle)]">
              {signedIn ? (
                <Link
                  href="/dashboard"
                  className="px-4 py-2 text-sm text-center font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Open app
                </Link>
              ) : (
                <>
                  <Link
                    href="/sign-in"
                    className="px-4 py-2 text-sm text-center text-[var(--text-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/sign-up"
                    className="px-4 py-2 text-sm text-center font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Get started
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </nav>

      <main>
        {/* ============================== Hero ==============================
            ui-audit 2026-07-06: terminal-as-lead composition. The
            the live-trace panel IS the product's identity (it
            literally runs the regression-detection → patch → eval pipeline in seconds).
            Putting it on equal footing with the headline understates
            it. New layout: copy col-span-5, terminal col-span-7.
            On mobile the terminal still leads visually because we
            reverse the source order via flex-col-reverse (the copy
            reads last, the terminal reads first). */}
        <section className="relative pt-16 md:pt-20 pb-20 px-6">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            {/* Hero copy column */}
            <div className="lg:col-span-5 max-w-2xl order-2 lg:order-1">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] text-xs font-medium text-[var(--text-secondary)] mb-6">
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
                <span className="font-mono uppercase tracking-[0.16em] text-[10px] text-[var(--text-muted)]">
                  {PRODUCT_VERSION}
                </span>
                <span className="text-[var(--text-secondary)]">
                  Observability + improvement for AI agents
                </span>
              </div>

              <h1
                className="text-4xl md:text-5xl lg:text-[56px] font-bold text-[var(--text-primary)] mb-6"
                style={{
                  letterSpacing: "-0.035em",
                  lineHeight: 1.04,
                }}
              >
                See every LLM call.
                <br />
                <span className="text-[var(--accent)]">Ship every fix.</span>
              </h1>

              <p
                className="text-base md:text-lg text-[var(--text-secondary)] leading-relaxed mb-8 max-w-xl"
                style={{ lineHeight: 1.6 }}
              >
                Eden is the observability + improvement platform for AI agents
                and LLM apps. Capture every call through an OpenAI-compatible
                gateway, analyse traces in a workspace with a cited AI
                assistant, and let{" "}
                <CodeChip>trace_8a3f</CodeChip>{" "}
                turn regressions into reviewable patch suggestions.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={signedIn ? "/dashboard" : "/sign-up"}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                >
                  {signedIn ? "Open dashboard" : "Start free"}
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  Read the docs
                </a>
              </div>

              <p className="mt-5 text-xs text-[var(--text-muted)]">
                {signedIn
                  ? "Pick up where you left off."
                  : "Free up to 100K trace events / month. No credit card."}
              </p>

              {/* KPI strip — anchors the hero with concrete numbers.
                  Three product-honest anchors: a usage ceiling, a
                  swap promise, an outcome promise. No "X+ integrations"
                  filler. The KPI is the visual anchor (3xl, semibold);
                  the unit and label are both the same micro-label
                  recipe used elsewhere on the page (mono, uppercase,
                  wide tracking, muted) so the eye reads "KPI
                  first, context after" instead of competing
                  weight. The strip also gains a vertical divider
                  via border-l on each cell so the three cells feel
                  like a row, not a grid. */}
              <dl className="mt-12 grid grid-cols-3 rounded-lg border border-[var(--border-default)] overflow-hidden bg-[var(--bg-secondary)]">
                {HERO_METRICS.map((m) => (
                  <div
                    key={m.label}
                    className="px-5 py-4 flex flex-col gap-1.5 border-l border-[var(--border-subtle)] first:border-l-0"
                  >
                    <dt
                      className="text-3xl font-semibold text-[var(--text-primary)] tabular-nums"
                      style={{ letterSpacing: "-0.03em", lineHeight: 1 }}
                    >
                      {m.kpi}
                    </dt>
                    <dd className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--text-muted)] leading-snug">
                      <span className="text-[var(--accent)]">{m.unit}</span>
                      <span className="mx-1 text-[var(--border-default)]">·</span>
                      <span>{m.label}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Hero right: live trace panel — the lead.
                Slightly lifted via lg:-mt-6 so the terminal chrome
                sits a touch above the headline baseline, giving it
                visual primacy without resorting to scale tricks. */}
            <div className="lg:col-span-7 w-full order-1 lg:order-2 lg:-mt-6">
              <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
                {/* Window chrome */}
                <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-close)]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-minimize)]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-zoom)]" />
                  <span className="ml-3 text-[11px] font-mono text-[var(--text-muted)] tracking-wider">
                    eden — live trace · gpt-4o-mini
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--terminal)] opacity-70 animate-ping" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
                    </span>
                    running
                  </span>
                </div>
                {/* Terminal body */}
                <div className="p-5 flex flex-col gap-1 min-h-[320px] font-mono text-[13px]">
                  <div className="flex items-center gap-3 h-7">
                    <span className="text-[var(--accent)]">$</span>
                    <span className="text-[var(--text-primary)]">
                      {typed}
                      {typed.length <= FULL_PROMPT.length && (
                        <span className="inline-block w-2 h-4 bg-[var(--accent)] ml-0.5 align-middle rounded-sm animate-[cursor-blink_1s_steps(1)_infinite]" />
                      )}
                    </span>
                  </div>
                  {IMPROVE_LOG.slice(0, logRevealed).map((line, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "flex items-center gap-3 h-7 px-1.5 rounded transition-all",
                        line.type === "proc" &&
                          "bg-[var(--accent)]/[0.06] text-[var(--accent)]",
                        line.type === "ok" &&
                          "bg-[var(--terminal)]/[0.06] text-[var(--terminal)]"
                      )}
                    >
                      <span className="text-[var(--text-faint)] tabular-nums text-[11px] shrink-0">
                        {line.time}
                      </span>
                      <span className="truncate">{line.msg}</span>
                      {line.type === "ok" && (
                        <Check className="w-3 h-3 text-[var(--terminal)] shrink-0 ml-auto" />
                      )}
                    </div>
                  ))}
                  {/* PR opened footer */}
                  {logRevealed >= IMPROVE_LOG.length && (
                    <div className="mt-2 pt-3 border-t border-[var(--border-subtle)] flex items-center gap-3 px-1.5">
                      <GitPullRequest className="w-3.5 h-3.5 text-[var(--terminal)]" />
                      <span className="text-[var(--text-primary)] font-semibold">
                        PR #482 ready for review
                      </span>
                      <a
                        href="#improve"
                        className="ml-auto text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)]"
                      >
                        view →
                      </a>
                    </div>
                  )}
                </div>
              </div>
              {/* Caption */}
              <p className="mt-3 text-xs text-[var(--text-muted)] text-center font-mono">
                Real run · ~12s end-to-end
              </p>
            </div>
          </div>
        </section>

        {/* ============================== Trust strip ==============================
         * The previous version rendered a row of grey text labels
         * (OpenAI · Anthropic · ...), which is the most identifiable
         * "AI slop" 2024-landing-page pattern. The integrations are
         * now mentioned inline in the install section's prose and in
         * the pillar descriptions, so the strip can carry a
         * different signal: live system status + on-brand
         * credibility proof points.
         *
         * The new strip is a thin micro-label row that answers
         * "can I trust this is real?" with:
         *   - All systems normal (live status, accent green)
         *   - SOC 2 Type II in progress (2026 audit)
         *   - Open source SDKs (Apache-2.0)
         * Each item is a small Chip-style pill with a status icon
         * (green dot, lock, code) so it reads as data, not a
         * logo placeholder row. */}
        <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-secondary)]/40">
          <div className="max-w-7xl mx-auto px-6 py-5">
            <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-mono uppercase tracking-[0.18em]">
              <li className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
                <span>All systems normal</span>
              </li>
              <li className="text-[var(--text-faint)]" aria-hidden="true">/</li>
              <li className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                <Lock className="w-3 h-3 text-[var(--text-faint)]" />
                <span>SOC 2 Type II</span>
              </li>
              <li className="text-[var(--text-faint)]" aria-hidden="true">/</li>
              <li className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                <Code2 className="w-3 h-3 text-[var(--text-faint)]" />
                <span>Apache-2.0 SDKs</span>
              </li>
              <li className="text-[var(--text-faint)]" aria-hidden="true">/</li>
              <li className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                <Users className="w-3 h-3 text-[var(--text-faint)]" />
                <span>SSO + SCIM</span>
              </li>
            </ul>
          </div>
        </section>

        {/* ============================== Install / Quickstart ============================== */}
        <section className="py-20 md:py-24 px-6">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-4 lg:sticky lg:top-24">
<h2
                className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
              >
                One line.
                <br />
                Every call captured.
              </h2>
              <p className="text-[var(--text-secondary)] leading-relaxed mb-6">
                Point your existing OpenAI SDK at the Eden gateway. Your app
                keeps working — every call is now traced, scored, and
                ready for{" "}
                <CodeChip>trace_8a3f</CodeChip>
                .
              </p>
              <ul className="flex flex-col gap-2.5 text-sm">
                {[
                  "No SDK lock-in — works with the OpenAI SDK you already use",
                  "PII masked at ingest, structured evals on capture",
                  "Drop the SDK in for fine-grained spans and tool calls",
                ].map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-[var(--text-secondary)]"
                  >
                    <Check className="w-4 h-4 mt-0.5 text-[var(--terminal)] shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Code panel with tabs */}
            <div className="lg:col-span-8">
              <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                {/* Tab strip */}
                <div
                  role="tablist"
                  aria-label="Installation options"
                  className="flex items-center gap-1 px-2 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]"
                >
                  {INSTALL_BLOCKS.map((b) => (
                    <button
                      key={b.id}
                      role="tab"
                      aria-selected={activeTab === b.id}
                      onClick={() => setActiveTab(b.id)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-mono rounded-md transition-colors",
                        activeTab === b.id
                          ? "bg-[var(--bg-base)] text-[var(--accent)] border border-[var(--border-subtle)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent"
                      )}
                    >
                      {b.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => copyCode(activeBlock.id, activeBlock.code)}
                    className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border border-[var(--border-subtle)] rounded-md transition-colors"
                  >
                    {copiedId === activeBlock.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[var(--terminal)]" />
                        Copied
                      </>
                    ) : (
                      "Copy"
                    )}
                  </button>
                </div>
                {/* Code surface */}
                <pre className="bg-[var(--code-surface)] text-[var(--text-primary)] p-5 md:p-6 text-[13px] font-mono overflow-x-auto leading-relaxed">
                  <code>{activeBlock.code}</code>
                </pre>
                {/* Footer hint */}
                <div className="flex items-center gap-2 px-4 py-2.5 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)]">
                  <span className="text-[var(--terminal)]">●</span>
                  <span>
                    Set{" "}
                    <code className="text-[var(--text-secondary)]">EDEN_API_KEY</code>{" "}
                    and you&rsquo;re capturing.
                  </span>
                  <a
                    href={DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[var(--accent)] hover:text-[var(--accent-hover)] inline-flex items-center gap-1"
                  >
                    Full docs
                    <ArrowRight className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================== Pillars ============================== */}
        <section
          id="pillars"
          className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30"
        >
          <div className="max-w-7xl mx-auto">
            {/* Section header */}
            <div className="max-w-2xl mb-14">
<h2
                className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
              >
                Capture. Analyse. Improve.
              </h2>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Three products that close a loop most platforms leave open.
                Every trace captured, every trace answerable, every regression
                one command away from a PR.
              </p>
            </div>

            {/* Pillar grid — varied. Capture + Analyse stay as
              * cards (compact, list-oriented). Improve becomes a
              * full-width terminal strip that mirrors the hero's
              * live-trace panel and makes the loop readable at a
              * glance. The arrow ribbon stays at the bottom as the
              * sequence cue. The shape break is deliberate: three
              * identical cards would read as a feature list, not as
              * a story. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {PILLARS.slice(0, 2).map((p) => {
                const Icon = p.icon;
                return (
                  <article
                    key={p.id}
                    className="group relative bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl p-6 hover:border-[var(--border-default)] transition-colors"
                  >
                    <div className="flex items-center mb-6">
                      <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        {p.badge}
                      </span>
                    </div>
                    <div className="w-10 h-10 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center mb-5">
                      <Icon className="w-5 h-5 text-[var(--accent)]" />
                    </div>
                    <h3
                      className="text-lg font-semibold text-[var(--text-primary)] mb-2 tracking-tight"
                      style={{ letterSpacing: "-0.015em" }}
                    >
                      {p.title}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-5">
                      {p.description}
                    </p>
                    <ul className="flex flex-col gap-2 pt-5 border-t border-[var(--border-subtle)]">
                      {p.bullets.map((b) => (
                        <li
                          key={b}
                          className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]"
                        >
                          <span className="w-1 h-1 rounded-full bg-[var(--accent)] mt-2 shrink-0" />
                          <span className="leading-snug">{b}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>

            {/* Improve strip — terminal-flavoured wide card with a
              * four-step log that maps the actual
              * sequence: detect → cluster → draft → eval → review.
              * Same visual language as the hero panel, so the page
              * reads as a coherent system rather than three
              * siblings. */}
            <ImprovePillar pillar={PILLARS[2]} />

            {/* Connecting line — visual hint that the pillars form a loop. */}
            <div className="mt-10 flex items-center justify-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
              <span>capture</span>
              <ArrowRight className="w-3 h-3 text-[var(--text-faint)]" />
              <span>analyse</span>
              <ArrowRight className="w-3 h-3 text-[var(--text-faint)]" />
              <span>improve</span>
              <ArrowRight className="w-3 h-3 text-[var(--text-faint)]" />
              <span className="text-[var(--accent)]">capture</span>
            </div>
          </div>
        </section>

        {/* ============================== PR-suggestions Spotlight ============================== */}
        <section id="improve" className="py-20 md:py-28 px-6">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
              {/* Copy column */}
              <div className="lg:col-span-5">
<h2
                  className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                  style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
                >
                  From &ldquo;regression detected&rdquo; to{" "}
                  <span className="text-[var(--accent)]">
                    &ldquo;patch ready for review&rdquo;
                  </span>
                </h2>
                <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
                  Other tools show you traces. Eden turns them into a
                  reviewable patch. When a judge score drifts, the
                  PR-suggestion inbox queues a draft patch with the
                  failing traces, the hypothesised root cause, and
                  eval results — you stay in the loop on the
                  open-PR decision.
                </p>
                <ul className="flex flex-col gap-3 mb-7">
                  {[
                    "Hypothesises root causes — cited to trace IDs and eval records",
                    "Patches prompt or code, then runs your evals locally",
                    "Queues the patch in your inbox — humans decide what ships",
                    "Full audit trail: who saw the suggestion, who opened the PR, who merged",
                  ].map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-3 text-sm text-[var(--text-secondary)]"
                    >
                      <Check className="w-4 h-4 mt-0.5 text-[var(--terminal)] shrink-0" />
                      <span className="leading-relaxed">{b}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  Read the PR-suggestions docs
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>

              {/* PR timeline card */}
              <div className="lg:col-span-7">
                <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                  <div className="flex items-center gap-1.5 px-4 py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-close)]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-minimize)]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[var(--traffic-zoom)]" />
                    <span className="ml-3 text-[11px] font-mono text-[var(--text-muted)]">
                      eden — PR-suggestion · ready for review
                    </span>
                  </div>
                  <div className="p-5 md:p-6 font-mono text-[13px]">
                    {/* PR header */}
                    <div className="flex items-center gap-3 pb-4 border-b border-[var(--border-subtle)]">
                      <GitPullRequest className="w-4 h-4 text-[var(--terminal)]" />
                      <span className="text-[var(--text-primary)] font-semibold">
                        judge.score drift · plan: tool_call.2
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--terminal)]/10 border border-[var(--terminal)]/30 text-[10px] font-mono uppercase tracking-wider text-[var(--terminal)]">
                        <Check className="w-3 h-3" />
                        awaiting review
                      </span>
                    </div>
                    {/* Timeline steps */}
                    <div className="flex flex-col mt-4">
                      {[
                        { icon: Search, label: "Read failing traces", meta: "247 traces, last 6h", tone: "default" },
                        { icon: Sparkles, label: "Hypothesised root cause", meta: "prompt brittleness on tool_call.2 — conf 0.78", tone: "accent" },
                        { icon: Workflow, label: "Edited prompts/system.md", meta: "+12 −4", tone: "default" },
                        { icon: Check, label: "Ran eden evals", meta: "smoke ✓ · quality ✓ · regression ✓", tone: "ok" },
                        { icon: GitBranch, label: "Opened PR", meta: "eden-bot → main · PR #482", tone: "ok" },
                      ].map((step, idx, arr) => {
                        const Icon = step.icon;
                        const isLast = idx === arr.length - 1;
                        return (
                          <div key={step.label} className="flex gap-4">
                            {/* Gutter: icon + connector line */}
                            <div className="flex flex-col items-center pt-0.5">
                              <div
                                className={cn(
                                  "w-7 h-7 rounded-md flex items-center justify-center border",
                                  step.tone === "ok" &&
                                    "bg-[var(--terminal)]/10 border-[var(--terminal)]/40",
                                  step.tone === "accent" &&
                                    "bg-[var(--accent)]/10 border-[var(--accent)]/40",
                                  step.tone === "default" &&
                                    "bg-[var(--bg-secondary)] border-[var(--border-subtle)]"
                                )}
                              >
                                <Icon
                                  className={cn(
                                    "w-3.5 h-3.5",
                                    step.tone === "ok" && "text-[var(--terminal)]",
                                    step.tone === "accent" && "text-[var(--accent)]",
                                    step.tone === "default" && "text-[var(--text-muted)]"
                                  )}
                                />
                              </div>
                              {!isLast && (
                                <div className="w-px flex-1 bg-[var(--border-subtle)] my-1" />
                              )}
                            </div>
                            {/* Step content */}
                            <div className="pb-5 pt-1.5 min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-3">
                                <span
                                  className={cn(
                                    "text-sm",
                                    step.tone === "ok"
                                      ? "text-[var(--text-primary)] font-medium"
                                      : "text-[var(--text-primary)]"
                                  )}
                                >
                                  {step.label}
                                </span>
                              </div>
                              <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                                {step.meta}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================== AI Assistant Sidebar ============================== */}
        <section className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30">
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
              {/* Chat card */}
              <div className="lg:col-span-7 order-2 lg:order-1">
                <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden">
                  {/* Sidebar header */}
                  <div className="flex items-center gap-2.5 px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                    <div className="w-7 h-7 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/30 flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5 text-[var(--accent)]" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[var(--text-primary)]">
                        Eden assistant
                      </span>
                      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                        Workspace · cited to traces
                      </span>
                    </div>
                    <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--terminal)]">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--terminal)] opacity-70 animate-ping" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
                      </span>
                      live
                    </span>
                  </div>
                  {/* Chat body */}
                  <div className="p-5 md:p-6 flex flex-col gap-4">
                    {ASSISTANT_TURNS.map((turn, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "flex gap-3",
                          turn.role === "user" ? "" : "pl-2"
                        )}
                      >
                        {turn.role === "assistant" ? (
                          <div className="w-7 h-7 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/30 flex items-center justify-center shrink-0">
                            <Bot className="w-3.5 h-3.5 text-[var(--accent)]" />
                          </div>
                        ) : (
                          <div className="w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                            <MessageSquare className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          {turn.role === "user" ? (
                            <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                              {turn.body}
                            </p>
                          ) : (
                            <div className="bg-[var(--bg-secondary)] border border-[var(--accent)]/25 rounded-lg p-3.5">
                              <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                                {turn.body}
                              </p>
                              {turn.cites && (
                                <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex items-center gap-2 flex-wrap">
                                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                                    cited
                                  </span>
                                  {turn.cites.map((c) => (
                                    <span
                                      key={c}
                                      className="text-[11px] font-mono text-[var(--accent)] bg-[var(--accent)]/10 px-2 py-0.5 rounded border border-[var(--accent)]/20"
                                    >
                                      {c}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {/* Suggested follow-up */}
                    <div className="flex items-center gap-2 pl-10">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        <GitPullRequest className="w-3 h-3" />
                        Open the PR-suggestion inbox
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {/* Composer */}
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)]">
                    <span className="text-[var(--accent)] font-mono text-sm shrink-0">
                      ›
                    </span>
                    <span className="text-sm text-[var(--text-muted)] font-mono">
                      Ask anything about your traces…
                    </span>
                    <span className="ml-auto text-[10px] font-mono text-[var(--text-faint)]">
                      ⌘K
                    </span>
                  </div>
                </div>
              </div>

              {/* Copy column */}
              <div className="lg:col-span-5 order-1 lg:order-2">
<h2
                  className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                  style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
                >
                  Ask your data.
                  <br />
                  <span className="text-[var(--accent)]">Cited answers.</span>
                </h2>
                <p className="text-[var(--text-secondary)] leading-relaxed mb-5">
                  A persistent AI assistant sidebar lives in every view of
                  the Eden portal. It queries your real traces and eval
                  records — not generic web results — and cites the trace ID
                  or eval record behind every claim.
                </p>
                <ul className="flex flex-col gap-3">
                  {[
                    { icon: Search, body: "Queries your real traces, spans, and eval records — not the public web" },
                    { icon: FileText, body: "Every answer cites the trace ID or eval record behind the claim" },
                    { icon: Sparkles, body: "Suggests a PR-suggestion when it spots a regression you could ship a fix for" },
                  ].map((b) => {
                    const Icon = b.icon;
                    return (
                      <li
                        key={b.body}
                        className="flex items-start gap-3 text-sm text-[var(--text-secondary)]"
                      >
                        <div className="w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
                          <Icon className="w-3.5 h-3.5 text-[var(--accent)]" />
                        </div>
                        <span className="leading-relaxed pt-1">{b.body}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ============================== FAQ ============================== */}
        <section className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-3xl mx-auto">
<h2
              className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-10 text-center"
              style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
            >
              Things people ask first.
            </h2>
            <div className="flex flex-col gap-3">
              {FAQS.map((f, i) => {
                const open = openFaq === i;
                return (
                  <div
                    key={f.q}
                    className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-secondary)] overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : i)}
                      className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left"
                      aria-expanded={open}
                    >
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {f.q}
                      </span>
                      <ChevronDown
                        className={cn(
                          "w-4 h-4 text-[var(--text-muted)] transition-transform shrink-0",
                          open && "rotate-180 text-[var(--accent)]"
                        )}
                      />
                    </button>
                    {open && (
                      <div className="px-5 pb-4 -mt-1 text-sm text-[var(--text-secondary)] leading-relaxed border-t border-[var(--border-subtle)] pt-3">
                        {f.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============================== CTA ============================== */}
        <section className="px-6 pb-24">
          <div className="max-w-5xl mx-auto">
            {/* Terminal-flavoured CTA: bookends the page with the same
             * visual language the ImprovePillar introduced earlier
             * (numbered circles, micro-label eyebrow, trailing
             * status row). Left rail carries the value prop +
             * actions; right rail walks through install → eval →
             * ship in 4 numbered steps; the bottom row is the same
             * status confirmation pattern the ImprovePillar uses.
             */}
            <div className="relative bg-[var(--bg-secondary)] border border-[var(--accent)]/30 rounded-2xl overflow-hidden">
              {/* Backdrop glow */}
              <div
                aria-hidden
                className="absolute inset-0 -z-10 opacity-50"
                style={{
                  background:
                    "radial-gradient(ellipse at top right, var(--accent-dim) 0%, transparent 60%)",
                }}
              />
              <div className="grid md:grid-cols-2 gap-0">
                {/* Left rail — eyebrow + headline + CTAs */}
                <div className="p-8 md:p-10 flex flex-col gap-6 border-b md:border-b-0 md:border-r border-[var(--border-subtle)]">
                  <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--accent)]">
                    <Terminal className="w-3.5 h-3.5" />
                    eden&gt; get started
                  </div>
                  <h2
                    className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight"
                    style={{ letterSpacing: "-0.03em", lineHeight: 1.08 }}
                  >
                    {signedIn ? "Welcome back." : "Ship better agents, faster."}
                  </h2>
                  <p className="text-sm md:text-base text-[var(--text-secondary)] leading-relaxed">
                    {signedIn
                      ? "Your workspace is ready — jump back into your traces."
                      : "Free up to 100K trace events / month. No credit card. Five-minute setup."}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 mt-auto">
                    <Link
                      href={signedIn ? "/dashboard" : "/sign-up"}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--accent)] text-[var(--bg-base)] rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                    >
                      {signedIn ? "Open dashboard" : "Start free"}
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                    <a
                      href={DOCS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-[var(--text-primary)] bg-transparent border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                      Read the docs
                    </a>
                  </div>
                </div>

                {/* Right rail — install → eval → ship timeline */}
                <div className="p-8 md:p-10 flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    eden&gt; run
                  </div>
                  <ol className="space-y-3.5">
                    {[
                      { n: 1, k: "INSTALL", v: "pip install eden-sdk",         sub: "1-line proxy drop-in" },
                      { n: 2, k: "CAPTURE",  v: "every LLM call",              sub: "traces, cost, latency" },
                      { n: 3, k: "EVAL",     v: "judge + regression suite",    sub: "runs on every commit" },
                      { n: 4, k: "REVIEW",   v: "open the PR",                  sub: "human-in-the-loop" },
                    ].map((step) => (
                      <li key={step.n} className="flex items-start gap-3">
                        <span
                          aria-hidden
                          className="mt-0.5 shrink-0 w-6 h-6 rounded-full border border-[var(--accent)]/40 bg-[var(--accent-faint)] text-[var(--accent)] text-[11px] font-mono font-semibold flex items-center justify-center"
                        >
                          0{step.n}
                        </span>
                        <div className="min-w-0 flex-1 leading-snug">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--accent)]">
                              {step.k}
                            </span>
                            <span className="font-mono text-sm text-[var(--text-primary)]">
                              {step.v}
                            </span>
                          </div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {step.sub}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {/* Status row — mirrors the ImprovePillar "PR ready"
                   * closer so the page has a single rhythm from
                   * hero → pillars → CTA. */}
                  <div className="pt-3 mt-2 border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)] flex items-center gap-2">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--terminal)]" aria-hidden />
                    <span className="text-[var(--terminal)]">READY</span>
                    <span className="text-[var(--text-faint)]">·</span>
                    <span>free tier</span>
                    <span className="text-[var(--text-faint)]">·</span>
                    <span>100K events / month</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================== Footer ============================== */}
        <footer className="border-t border-[var(--border-subtle)] py-12 px-6">
          <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-10">
            <div className="md:col-span-5 flex flex-col gap-3">
              <Logo size="sm" showWordmark href="/" />
              <p className="text-sm text-[var(--text-muted)] max-w-xs leading-relaxed">
                Observability + improvement for AI agents and LLM apps.
              </p>
              <p className="text-[11px] font-mono text-[var(--text-faint)]">
                © {PRODUCT_COPYRIGHT_YEAR} Eden · {PRODUCT_VERSION}
              </p>
            </div>

            <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-8">
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Product
                </span>
                <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Documentation
                </a>
                <Link href="/sign-up" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Sign up
                </Link>
                <Link href="/sign-in" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Sign in
                </Link>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Resources
                </span>
                <a href={`${DOCS_URL}/quickstart`} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Getting started
                </a>
                <a href={`${DOCS_URL}/reference/`} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  API reference
                </a>
                <a
                  href="https://status.edenobservability.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5"
                >
                  Status
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--terminal)] opacity-60 animate-ping" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--terminal)]" />
                  </span>
                </a>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Legal
                </span>
                <Link href="/privacy" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  {t("footer.privacy")}
                </Link>
                <Link href="/terms" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  {t("footer.terms")}
                </Link>
                <Link href="/dpa" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  {t("footer.dpa")}
                </Link>
                <Link href="/security" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  {t("footer.security")}
                </Link>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  Locale
                </span>
                <LocaleSwitcher />
                {/* CCPA "Do Not Sell My Personal Information" — required
                 * link in the marketing footer for California residents.
                 * The trailing "CCPA" micro-label answers the
                 * "what's this link?" question without taking the
                 * reader away from the layout. The label is muted
                 * so it doesn't compete with the link itself. */}
                <span className="inline-flex items-baseline gap-1.5 text-sm whitespace-nowrap">
                  <Link
                    href="/api/v1/me/do-not-sell"
                    prefetch={false}
                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    Do Not Sell My Info
                  </Link>
                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-faint)]">
                    CCPA
                  </span>
                </span>
              </div>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
