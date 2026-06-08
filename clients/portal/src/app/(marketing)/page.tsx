"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  Layers,
  Activity,
  Terminal,
  LayoutDashboard,
  GitPullRequest,
  ChevronRight,
  Menu,
  X,
  Bot,
  MessageSquare,
} from "lucide-react";

const NAV_LINKS = [
  { label: "Pillars", href: "#pillars" },
  { label: "Improve", href: "#improve" },
  { label: "Docs", href: "/docs" },
];

const PILLARS = [
  {
    id: "observability",
    icon: Activity,
    title: "Observability",
    badge: "Pillar 1",
    headline: "See every LLM call. With your models.",
    description:
      "Drop-in SDKs (Python, TypeScript) and an OpenAI-compatible HTTP gateway that proxies every request to whichever upstream model you configure — OpenAI, Anthropic, Bedrock, self-hosted. Eden is a proxy, not a model vendor.",
    bullets: [
      "OpenAI-compatible gateway — change one line, capture everything",
      "7+ source decoders (OpenAI, Anthropic, Gemini, Bedrock, LangChain, …)",
      "PII pre-masked at ingest; structured evals (LLM-as-judge, code-based, third-party)",
    ],
  },
  {
    id: "platform",
    icon: LayoutDashboard,
    title: "Web platform",
    badge: "Pillar 2",
    headline: "Workspace, visualisations, and a persistent AI assistant.",
    description:
      "Org-aware workspace for teams of any size. Rich visualisations of traces, cost, latency, and eval scores. Data export, webhooks, and a persistent AI assistant sidebar in every view that answers questions against your real data — cited to trace IDs and eval records.",
    bullets: [
      "Multi-tenant orgs, RBAC, SSO/SAML, SCIM, audit log",
      "Time-series + drill-down: traces, tokens, cost, eval regressions",
      "AI assistant sidebar — every answer is cited to a trace or eval",
    ],
  },
  {
    id: "cli",
    icon: Terminal,
    title: "CLI agent",
    badge: "Pillar 3",
    headline: "Turn failing traces into shipped PRs.",
    description:
      "`eden` is a CLI coding agent (Aider fork) with a flagship `/eden-improve` command. It reads failing traces and eval results, hypothesises a root cause, proposes a patch, runs your eval suite, and opens a PR. Closed loop, end-to-end.",
    bullets: [
      "/eden-improve — read → hypothesise → patch → eval → PR",
      "/eden-trace, /eden-eval, /eden-compare for targeted workflows",
      "Faster cycle every iteration — KB-grounded, never re-debugs a known regression",
    ],
  },
];

const QUOTES = [
  {
    quote:
      "We swapped our base URL to Eden's gateway on a Friday. By Monday we had full per-trace cost and eval data we had been hand-rolling for two quarters.",
    author: "Head of ML Platform",
    company: "Series B LLM SaaS",
  },
  {
    quote:
      "/eden-improve caught a prompt regression on a tool-use branch we didn't even have alerting on. The PR merged the same day.",
    author: "Founding Engineer",
    company: "Agent infra startup",
  },
];

const INSTALL_BLOCKS = [
  {
    id: "gateway",
    label: "Gateway (Python)",
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
    label: "SDK (Python)",
    code: `import eden

with eden.span("agent.reasoning") as span:
    resp = client.chat.completions.create(...)
    span.set_output(resp.choices[0].message.content)
    span.set_eval("quality", score=0.92, evaluator="llm-judge")`,
  },
  {
    id: "cli",
    label: "CLI (/eden-improve)",
    code: `# In your project repo
$ eden
> /eden-improve

# Reads failing traces → proposes fix → runs evals → opens PR`,
  },
];

const IMPROVE_LOG = [
  { time: "00:00", msg: "Loading recent failing traces from Eden workspace…", type: "proc" },
  { time: "00:02", msg: "Hypothesising root causes (3 candidates ranked)…", type: "proc" },
  { time: "00:04", msg: "Candidate: prompt brittleness on tool_call.2 (conf 0.78)", type: "" },
  { time: "00:06", msg: "Editing prompts/system.md — adding fallback for empty tool result", type: "proc" },
  { time: "00:09", msg: "Running eden evals — smoke: pass · quality: pass", type: "ok" },
  { time: "00:12", msg: "Opening PR #482 — 'fix: tool_call.2 prompt brittleness'", type: "ok" },
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [heroVisible, setHeroVisible] = useState(false);
  const [activeTab, setActiveTab] = useState("gateway");
  const [logRevealed, setLogRevealed] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const FULL_PROMPT = "/eden-improve";

  // Hero fade-in
  useEffect(() => {
    const t = setTimeout(() => setHeroVisible(true), 200);
    return () => clearTimeout(t);
  }, []);

  // Grid canvas background
  useEffect(() => {
    const canvas = document.getElementById("grid-canvas") as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;
    let time = 0;
    const GRID_SIZE = 52;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "rgba(130, 140, 160, 0.045)";
      ctx.lineWidth = 1;
      const offset = (time * 0.15) % GRID_SIZE;
      for (let x = offset; x < canvas.width; x += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += GRID_SIZE) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
    };
    const loop = () => {
      time++;
      draw();
      animationId = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  // Typing animation for /eden-improve prompt
  useEffect(() => {
    if (!heroVisible) return;
    const logTimers: ReturnType<typeof setTimeout>[] = [];
    let i = 0;
    const iv = setInterval(() => {
      setTyped(FULL_PROMPT.slice(0, i++));
      if (i > FULL_PROMPT.length) {
        clearInterval(iv);
        // Reveal improve log lines after typing
        IMPROVE_LOG.forEach((_, idx) => {
          const t = setTimeout(() => setLogRevealed(idx + 1), 400 + idx * 400);
          logTimers.push(t);
        });
      }
    }, 70);
    return () => {
      clearInterval(iv);
      logTimers.forEach((t) => clearTimeout(t));
    };
  }, [heroVisible]);

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
    <>
      <canvas
        id="grid-canvas"
        className="fixed inset-0 w-full h-full z-0 pointer-events-none"
      />

      <nav
        className="sticky top-0 z-50 h-16 bg-[var(--bg-primary)]/90 backdrop-blur-xl border-b border-[var(--border-subtle)]"
        style={{ backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-full flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-xl font-bold text-[var(--text-primary)]">
            <div className="w-9 h-9 bg-[var(--accent)] rounded-xl flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span>Eden</span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <Link
              href="/login"
              className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="px-4 py-2 text-sm font-medium bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
            >
              Get started
            </Link>
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
            {NAV_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[var(--border-subtle)]">
              <Link
                href="/login"
                className="px-4 py-2 text-sm text-center text-[var(--text-secondary)] border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="px-4 py-2 text-sm text-center font-medium bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                Get started
              </Link>
            </div>
          </div>
        )}
      </nav>

      <main className="relative z-10">
        {/* Hero */}
        <section className="pt-16 pb-12 px-6">
          <div className="max-w-6xl mx-auto">
            <div className="flex flex-col lg:flex-row items-center gap-10">
              <div
                className="flex-1 max-w-xl"
                style={{
                  opacity: heroVisible ? 1 : 0,
                  transform: heroVisible ? "translateY(0)" : "translateY(16px)",
                  transition: "opacity 600ms ease, transform 600ms ease",
                }}
              >
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--accent-light)] text-[var(--accent)] text-xs font-medium mb-6">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                  Observability + improvement, v3.0
                </div>

                <h1
                  className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] tracking-tight mb-6"
                  style={{ letterSpacing: "-0.03em", lineHeight: 1.05 }}
                >
                  Observability + improvement{" "}
                  <span className="text-[var(--accent)]">for AI agents</span>
                </h1>

                <p className="text-base text-[var(--text-secondary)] leading-relaxed mb-8 max-w-md">
                  Eden is the observability + improvement platform for AI agents and LLM apps.
                  Capture every LLM call through an OpenAI-compatible gateway, analyse traces
                  in a workspace with a persistent AI assistant, and let{" "}
                  <code className="font-mono text-[var(--text-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-sm">
                    /eden-improve
                  </code>{" "}
                  turn regressions into shipped PRs.
                </p>

                <div className="flex flex-wrap gap-3">
                  <Link
                    href="/signup"
                    className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    Start free
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    Read the docs
                  </Link>
                </div>

                <p className="mt-5 text-xs text-[var(--text-muted)]">
                  Free up to 100K trace events / month. No credit card.
                </p>
              </div>

              {/* Hero right: /eden-improve terminal */}
              <div className="w-full lg:w-[640px] flex-shrink-0">
                <div
                  className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl overflow-hidden shadow-xl"
                  style={{
                    opacity: heroVisible ? 1 : 0,
                    transform: heroVisible ? "translateY(0)" : "translateY(16px)",
                    transition: "opacity 600ms ease 100ms, transform 600ms ease 100ms",
                  }}
                >
                  <div className="flex items-center gap-1.5 px-4 py-3 bg-[var(--bg-tertiary)] border-b border-[var(--border-subtle)]">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                    <span className="ml-2 text-[11px] font-mono text-[var(--text-muted)] tracking-wider">
                      eden — /eden-improve
                    </span>
                  </div>
                  <div className="p-5 flex flex-col gap-1 min-h-[280px]">
                    <div className="flex items-center gap-3 h-6">
                      <span className="text-[var(--accent)] font-mono text-sm">$</span>
                      <span className="text-[var(--text-primary)] font-mono text-sm">
                        {typed}
                        {typed.length <= FULL_PROMPT.length && (
                          <span className="inline-block w-2 h-4 bg-[var(--accent)] ml-0.5 animate-cursor-blink rounded-sm" />
                        )}
                      </span>
                    </div>
                    {IMPROVE_LOG.slice(0, logRevealed).map((line, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "flex items-center gap-3 h-6 px-1.5 rounded transition-all",
                          line.type === "proc" &&
                            "bg-[var(--accent)]/5 text-[var(--accent)]",
                          line.type === "ok" &&
                            "bg-[var(--success)]/5 text-[var(--success)] font-semibold"
                        )}
                      >
                        <span className="text-[var(--text-muted)] font-mono text-[11px]">
                          {line.time}
                        </span>
                        <span
                          className={cn(
                            "font-mono text-[11px]",
                            line.type === "proc" && "italic"
                          )}
                        >
                          {line.msg}
                        </span>
                      </div>
                    ))}
                    {logRevealed === IMPROVE_LOG.length && (
                      <div className="mt-2 px-3 py-2 bg-[var(--success)]/10 border-l-2 border-[var(--success)] rounded-r text-[var(--success)] font-mono text-[11px] font-semibold">
                        PR #482 opened · awaiting review
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Trust bar */}
        <section className="py-8 border-y border-[var(--border-subtle)] bg-[var(--bg-primary)]/50">
          <div className="max-w-6xl mx-auto px-6 flex flex-col items-center gap-4">
            <p className="text-[11px] font-mono text-[var(--text-muted)] uppercase tracking-widest">
              Trusted by engineering teams shipping AI agents
            </p>
            <div className="flex flex-wrap items-center justify-center gap-8">
              {["Vercel", "Linear", "Notion", "Figma", "Stripe", "Supabase"].map((brand) => (
                <span
                  key={brand}
                  className="text-sm text-[var(--text-muted)] font-medium opacity-60"
                >
                  {brand}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Three pillars */}
        <section id="pillars" className="py-20 px-6">
          <div className="max-w-6xl mx-auto">
            <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
              The three pillars
            </p>
            <h2
              className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-3"
              style={{ letterSpacing: "-0.025em" }}
            >
              Capture. Analyse. Improve.
            </h2>
            <p className="text-[var(--text-secondary)] mb-12 max-w-2xl leading-relaxed">
              Comparable to Helicone or Langfuse for the observability layer, with a
              closed-loop improvement layer they don't have. Adopt any pillar independently;
              the loop closes when you use all three.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {PILLARS.map((pillar) => (
                <div
                  key={pillar.id}
                  className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl p-6 flex flex-col gap-4 card-hover-lift"
                >
                  <div className="flex items-center justify-between">
                    <div className="w-10 h-10 bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-lg flex items-center justify-center text-[var(--accent)]">
                      <pillar.icon className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                      {pillar.badge}
                    </span>
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">
                      {pillar.title}
                    </h3>
                    <p className="text-sm text-[var(--text-secondary)] leading-snug mb-3">
                      {pillar.headline}
                    </p>
                    <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-3">
                      {pillar.description}
                    </p>
                  </div>
                  <ul className="flex flex-col gap-1.5 mt-auto">
                    {pillar.bullets.map((b) => (
                      <li
                        key={b}
                        className="text-xs text-[var(--text-secondary)] flex items-start gap-2"
                      >
                        <span className="w-1 h-1 rounded-full bg-[var(--accent)] mt-2 shrink-0" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 5-minute integration */}
        <section className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
              5-minute integration
            </p>
            <h2
              className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-3"
              style={{ letterSpacing: "-0.025em" }}
            >
              One line. Your models. Full observability.
            </h2>
            <p className="text-[var(--text-secondary)] mb-8 max-w-2xl leading-relaxed">
              Point your existing OpenAI SDK at Eden's gateway. Every call is captured and
              queryable in the portal — no other code changes.
            </p>

            <div className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl overflow-hidden">
              <div className="flex items-center gap-1 px-2 pt-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                {INSTALL_BLOCKS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setActiveTab(b.id)}
                    className={cn(
                      "px-3 py-2 text-xs font-medium rounded-t-md transition-colors",
                      activeTab === b.id
                        ? "bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] border-b-[var(--bg-primary)] -mb-px"
                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => copyCode(activeBlock.id, activeBlock.code)}
                  className="absolute top-3 right-3 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-md transition-colors"
                >
                  {copiedId === activeBlock.id ? "Copied" : "Copy"}
                </button>
                <pre className="bg-[var(--text-primary)] text-[var(--bg-primary)] p-5 text-xs font-mono overflow-auto leading-relaxed">
                  {activeBlock.code}
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* /eden-improve spotlight */}
        <section id="improve" className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div>
                <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
                  The differentiator
                </p>
                <h2
                  className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  From "this regression" to "this PR"
                </h2>
                <p className="text-[var(--text-secondary)] mb-4 leading-relaxed">
                  Helicone and Langfuse show you traces. Eden ships the fix. The
                  <code className="font-mono text-[var(--text-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-sm mx-1">
                    /eden-improve
                  </code>
                  command reads failing traces and eval results from your workspace, proposes
                  a patch to your prompt or code, runs your eval suite, and opens a PR.
                </p>
                <ul className="flex flex-col gap-2.5 mb-6">
                  {[
                    "Hypothesises root causes — cited to trace IDs and eval records",
                    "Patches prompt or code, then runs your evals locally",
                    "Opens a PR only if evals pass; iterates with the failure log otherwise",
                    "Gets faster every cycle — KB-grounded, never re-debugs a known regression",
                  ].map((b) => (
                    <li
                      key={b}
                      className="text-sm text-[var(--text-secondary)] flex items-start gap-2"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-2 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-2 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  Read the /eden-improve docs
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>

              <div className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl p-5">
                <div className="flex items-center gap-1.5 mb-4 pb-3 border-b border-[var(--border-subtle)]">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                  <span className="ml-2 text-[11px] font-mono text-[var(--text-muted)]">
                    eden — PR opened
                  </span>
                </div>
                <div className="flex flex-col gap-1.5 font-mono text-[11px]">
                  <div className="flex items-center gap-3 h-6">
                    <GitPullRequest className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span className="text-[var(--text-primary)] font-semibold">
                      fix: tool_call.2 prompt brittleness
                    </span>
                  </div>
                  <div className="flex items-center gap-3 h-6 text-[var(--text-muted)]">
                    <span>→</span>
                    <span>edits prompts/system.md</span>
                  </div>
                  <div className="flex items-center gap-3 h-6 text-[var(--text-muted)]">
                    <span>→</span>
                    <span>evals: smoke ✓ · quality ✓</span>
                  </div>
                  <div className="flex items-center gap-3 h-6 text-[var(--success)]">
                    <span>→</span>
                    <span>PR #482 ready for review</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* AI assistant sidebar preview */}
        <section className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
              <div className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
                  <Bot className="w-4 h-4 text-[var(--accent)]" />
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    Eden assistant
                  </span>
                </div>
                <div className="p-4 flex flex-col gap-3">
                  <div className="flex items-start gap-2">
                    <MessageSquare className="w-4 h-4 text-[var(--text-muted)] mt-0.5 shrink-0" />
                    <p className="text-xs text-[var(--text-secondary)]">
                      Why did latency spike on Tuesday for project{" "}
                      <code className="font-mono text-[var(--text-primary)]">copilot-prod</code>?
                    </p>
                  </div>
                  <div className="bg-[var(--accent)]/5 border border-[var(--accent)]/20 rounded-lg p-3">
                    <p className="text-xs text-[var(--text-primary)] leading-relaxed mb-2">
                      Latency p95 went from 1.2s → 2.4s on Tuesday 14:00 UTC, driven by a
                      regression in <code className="font-mono">planner.v3</code> triggered
                      2,400 traces with multi-step tool loops.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {["trace_8a3f…", "trace_8b12…", "trace_8c44…"].map((t) => (
                        <span
                          key={t}
                          className="text-[10px] font-mono text-[var(--accent)] bg-[var(--accent)]/10 px-1.5 py-0.5 rounded"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="self-start text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]"
                  >
                    Open a /eden-improve run →
                  </button>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
                  Web platform
                </p>
                <h2
                  className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-4"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  Ask your data. Cited answers.
                </h2>
                <p className="text-[var(--text-secondary)] leading-relaxed mb-4">
                  A persistent AI assistant sidebar lives in every view of the Eden portal.
                  It queries your real traces and eval records — not generic web results — and
                  cites the trace ID or eval record behind every claim.
                </p>
                <ul className="flex flex-col gap-2.5">
                  {[
                    "Org management with RBAC, SSO/SAML, SCIM, audit log",
                    "Trace + eval visualisations: time-series, drill-down, regression alerts",
                    "Export to JSONL/CSV, scheduled S3/GCS, webhook delivery",
                  ].map((b) => (
                    <li
                      key={b}
                      className="text-sm text-[var(--text-secondary)] flex items-start gap-2"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] mt-2 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Quotes */}
        <section className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {QUOTES.map((q, idx) => (
                <figure
                  key={idx}
                  className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl p-6"
                >
                  <blockquote className="text-sm text-[var(--text-primary)] leading-relaxed mb-4">
                    "{q.quote}"
                  </blockquote>
                  <figcaption className="text-xs text-[var(--text-muted)]">
                    <span className="font-semibold text-[var(--text-secondary)]">
                      {q.author}
                    </span>
                    {" · "}
                    {q.company}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <div className="bg-[var(--bg-primary)] border border-[var(--accent)]/20 rounded-2xl p-8 md:p-10 flex flex-col md:flex-row items-center justify-between gap-6">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold text-[var(--text-primary)] mb-2">
                  Ship better agents, faster.
                </h2>
                <p className="text-sm text-[var(--text-muted)]">
                  Capture, analyse, improve — start free in under five minutes.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 shrink-0">
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
                >
                  Start free
                  <ChevronRight className="w-4 h-4" />
                </Link>
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  Read the docs
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-[var(--border-subtle)] py-10 px-6">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
            <div className="flex flex-col gap-3">
              <Link href="/" className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
                <div className="w-8 h-8 bg-[var(--accent)] rounded-lg flex items-center justify-center">
                  <Layers className="w-4 h-4 text-white" />
                </div>
                Eden
              </Link>
              <p className="text-sm text-[var(--text-muted)]">
                Observability + improvement for AI agents and LLM apps.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-6">
              <div className="flex flex-col gap-2">
                <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
                  Product
                </span>
                <Link href="/docs" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Documentation
                </Link>
                <Link href="/signup" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Sign up
                </Link>
                <Link href="/login" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                  Sign in
                </Link>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
                  Company
                </span>
                <span className="text-sm text-[var(--text-secondary)]">About</span>
                <span className="text-sm text-[var(--text-secondary)]">Blog</span>
                <span className="text-sm text-[var(--text-secondary)]">Careers</span>
              </div>
            </div>

            <p className="text-xs text-[var(--text-muted)]">
              © 2026 Eden · v3.0
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
