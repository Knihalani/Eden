"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  Layers,
  MessageSquare,
  Code2,
  Monitor,
  FileText,
  Globe,
  Shield,
  ChevronRight,
  Menu,
  X,
} from "lucide-react";

const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "Docs", href: "/docs" },
  { label: "Pricing", href: "#pricing" },
];

const FEATURES = [
  {
    icon: MessageSquare,
    title: "Plain language input",
    description:
      "Describe the environment you need in your own words. Eden figures out the technical requirements.",
  },
  {
    icon: Code2,
    title: "Multi-stage pipeline",
    description:
      "Intelligent planning, factual verification, code generation, and quality review — each stage builds on the last.",
  },
  {
    icon: Monitor,
    title: "Real-time monitoring",
    description:
      "Watch your environment generate live. Stage-by-stage progress, streaming output, instant feedback.",
  },
  {
    icon: FileText,
    title: "Full version history",
    description:
      "Every iteration is saved. Compare versions, review changes, roll back when needed.",
  },
  {
    icon: Globe,
    title: "Exportable code",
    description:
      "Download a complete, self-contained codebase. Works with your existing tools and CI/CD pipeline.",
  },
  {
    icon: Shield,
    title: "Quality verified",
    description:
      "Every environment passes automated validation before delivery. Code that runs, not skeleton templates.",
  },
];

const PIPELINE_STAGES = [
  { id: "planning", label: "Planning", done: true },
  { id: "factcheck", label: "Fact Check", active: true },
  { id: "executing", label: "Executing", pending: true },
  { id: "archivist", label: "Archivist", pending: true },
];

const LOG_LINES = [
  { time: "00:00", msg: "Validating environment spec...", type: "proc" },
];

const RESULT_LINES = [
  "Fetching tool registry from package index...",
  "Resolving memory store (Redis + vector KB)",
  "Building tool discovery schema (17 tools found)",
  "Compiling Docker environment with Python 3.12",
  "Writing agent prompt and system instructions",
  "Assembling self-contained codebase (12 files)",
  "Running validation suite — all checks passed",
  "Exporting deployment bundle to artifact storage",
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [pipelineStarted, setPipelineStarted] = useState(false);
  // completedCount tracks how many stages are done; activeStage tracks current stage
  // Initial: Planning (idx 0) is done, Fact Check (idx 1) is active
  const [completedCount, setCompletedCount] = useState(1);
  const [activeStage, setActiveStage] = useState(1);
  const [logLines, setLogLines] = useState(LOG_LINES);
  const [resultRevealed, setResultRevealed] = useState(0);
  const [typingDone, setTypingDone] = useState(false);
  const [cmdText, setCmdText] = useState("");
  const terminalRef = useRef<HTMLDivElement>(null);

  const CMD = 'describe: "multi-tool support agent with memory and dynamic tool discovery"';

  // Animate grid background
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

    const drawGrid = () => {
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

    const drawParticles = () => {
      const count = Math.floor((canvas.width * canvas.height) / 14000);
      for (let i = 0; i < count; i++) {
        const x = (Math.sin(time * 0.001 + i * 0.5) * 0.5 + 0.5) * canvas.width;
        const y = (Math.cos(time * 0.001 + i * 0.3) * 0.5 + 0.5) * canvas.height;
        const pulse = Math.sin(time * 0.002 + i) * 0.5 + 0.5;
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100, 200, 255, ${0.2 + pulse * 0.3})`;
        ctx.fill();
      }
    };

    const loop = () => {
      time++;
      drawGrid();
      drawParticles();
      animationId = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  // Terminal typing animation
  useEffect(() => {
    const timer = setTimeout(() => setTerminalVisible(true), 300);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!terminalVisible) return;
    let i = 0;
    const typeInterval = setInterval(() => {
      setCmdText(CMD.slice(0, i++));
      if (i > CMD.length) {
        clearInterval(typeInterval);
        setTypingDone(true);
        // Reveal result lines one by one
        RESULT_LINES.forEach((_, idx) => {
          setTimeout(() => setResultRevealed(idx + 1), 300 + idx * 350);
        });
      }
    }, 38);
    return () => clearInterval(typeInterval);
  }, [terminalVisible]);

  // Pipeline animation
  useEffect(() => {
    if (!terminalVisible) return;
    const timer = setTimeout(() => setPipelineStarted(true), 800);
    return () => clearTimeout(timer);
  }, [terminalVisible]);

  useEffect(() => {
    if (!pipelineStarted) return;
    const stages = [
      [
        { t: "00:01", m: "Parsing environment description" },
        { t: "00:02", m: "Identifying required tools and APIs", type: "proc" },
        { t: "00:03", m: "Designing agent decision graph" },
        { t: "00:05", m: "EDP complete — 12 tasks scoped", type: "ok" },
      ],
      [
        { t: "00:06", m: "Verifying EDP claims against knowledge base", type: "proc" },
        { t: "00:07", m: "Cross-referencing 34 service dependencies" },
        { t: "00:09", m: "All facts validated — 0 conflicts found", type: "ok" },
      ],
      [
        { t: "00:10", m: "Scaffolding agent skeleton with state machine", type: "proc" },
        { t: "00:12", m: "Generating tool registry from environment spec" },
        { t: "00:14", m: "Building Docker config and environment files" },
        { t: "00:16", m: "Writing agent prompt and system instructions" },
        { t: "00:19", m: "Code generation complete — 847 lines in 12 files", type: "ok" },
      ],
      [
        { t: "00:20", m: "Running code quality and lint checks", type: "proc" },
        { t: "00:22", m: "Adding knowledge base entries for searchability" },
        { t: "00:24", m: "Indexing environment for future reuse" },
        { t: "00:27", m: "Environment ready — deployment bundle prepared", type: "ok" },
      ],
    ];

    let stageIdx = 0;
    let lineIdx = 0;
    let timeoutId: ReturnType<typeof setTimeout>;

    const runLine = () => {
      if (stageIdx >= stages.length) return;
      const stage = stages[stageIdx];
      if (lineIdx >= stage.length) {
        // Mark current stage as done and advance active stage
        setCompletedCount(stageIdx + 1);
        setActiveStage(stageIdx + 1);
        stageIdx++;
        lineIdx = 0;
        if (stageIdx < stages.length) {
          timeoutId = setTimeout(runLine, 400);
        }
        return;
      }
      const line = stage[lineIdx];
      setLogLines((prev) => [...prev, { time: line.t, msg: line.m, type: line.type || "" }]);
      lineIdx++;
      timeoutId = setTimeout(runLine, 220);
    };

    timeoutId = setTimeout(runLine, 2800);
    return () => clearTimeout(timeoutId);
  }, [pipelineStarted]);

  return (
    <>
      {/* Grid canvas background */}
      <canvas
        id="grid-canvas"
        className="fixed inset-0 w-full h-full z-0 pointer-events-none"
      />

      {/* Sticky Nav */}
      <nav
        className="sticky top-0 z-50 h-16 bg-[var(--bg-primary)]/90 backdrop-blur-xl border-b border-[var(--border-subtle)]"
        style={{ backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-6xl mx-auto px-6 h-full flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 text-xl font-bold text-[var(--text-primary)]">
            <div className="w-9 h-9 bg-[var(--accent)] rounded-xl flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span>Eden</span>
          </Link>

          {/* Desktop nav links */}
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

          {/* Desktop CTA */}
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

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile menu */}
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
        {/* Hero Section */}
        <section className="pt-16 pb-12 px-6">
          <div className="max-w-6xl mx-auto">
            <div className="flex flex-col lg:flex-row items-center gap-10">
              {/* Hero content */}
              <div className="flex-1 max-w-xl">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--accent-light)] text-[var(--accent)] text-xs font-medium mb-6 animate-fade-slide-up">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                  Now in public beta
                </div>

                <h1
                  className="text-4xl md:text-5xl font-bold text-[var(--text-primary)] tracking-tight mb-6 animate-fade-slide-up"
                  style={{ letterSpacing: "-0.03em", lineHeight: 1.05 }}
                >
                  Build AI Agent Environments{" "}
                  <span className="text-[var(--accent)]">in Minutes</span>
                </h1>

                <p
                  className="text-base text-[var(--text-secondary)] leading-relaxed mb-8 max-w-md animate-fade-slide-up"
                  style={{ animationDelay: "80ms" }}
                >
                  Describe what you need in plain language. Eden builds a complete,
                  validated, runnable environment — ready to use on day one.
                </p>

                <div
                  className="flex flex-wrap gap-3 animate-fade-slide-up"
                  style={{ animationDelay: "160ms" }}
                >
                  <Link
                    href="/signup"
                    className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    Start building free
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

              {/* Right column: Pipeline + Terminal */}
              <div className="w-full lg:w-[640px] flex-shrink-0 flex flex-col gap-4">
                {/* Pipeline Flow */}
                <div
                  ref={terminalRef}
                  className={cn(
                    "bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl p-6 shadow-lg transition-all duration-500",
                    pipelineStarted && "shadow-xl",
                    activeStage === 4 && "shadow-2xl"
                  )}
                  style={{
                    opacity: terminalVisible ? 1 : 0,
                    transform: terminalVisible ? "translateY(0)" : "translateY(16px)",
                  }}
                >
                  <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-[var(--text-muted)] mb-5">
                    Pipeline — live preview
                  </div>
                  <div className="flex items-center gap-0 mb-5">
                    {PIPELINE_STAGES.map((stage, idx) => (
                      <div key={stage.id} className="flex flex-col items-center flex-1 relative">
                        {idx > 0 && (
                          <div
                            className={cn(
                              "absolute top-3.5 -left-1/2 w-full h-0.5",
                              idx < completedCount ? "bg-[var(--success)]" : "bg-[var(--border-subtle)]"
                            )}
                          />
                        )}
                        <div
                          className={cn(
                            "w-7 h-7 rounded-full border-2 flex items-center justify-center z-10 transition-all",
                            idx < completedCount
                              ? "bg-[var(--success)] border-[var(--success)]"
                              : idx === activeStage
                                ? "bg-[var(--accent)] border-[var(--accent)] ring-4 ring-[var(--accent)]/20"
                                : "bg-[var(--bg-primary)] border-[var(--border-default)]"
                          )}
                        >
                          {idx < completedCount ? (
                            <svg
                              className="w-3 h-3 text-white"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={3}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : idx === activeStage ? (
                            <svg
                              className="w-3 h-3 text-white"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={3}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
                            </svg>
                          ) : null}
                        </div>
                        <span
                          className={cn(
                            "text-[10px] font-mono font-semibold uppercase mt-2 text-center transition-colors",
                            idx < completedCount
                              ? "text-[var(--success)]"
                              : idx === activeStage
                                ? "text-[var(--accent)]"
                                : "text-[var(--text-muted)]"
                          )}
                        >
                          {stage.label}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/* Pipeline log */}
                  <div className="bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-xl p-5 font-mono text-[11px] flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                    {logLines.map((line, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "flex items-center gap-3 h-6 px-1.5 rounded transition-all duration-300",
                          line.type === "proc" && "bg-[var(--accent)]/5 text-[var(--accent)]",
                          line.type === "ok" && "bg-[var(--success)]/5 text-[var(--success)] font-semibold"
                        )}
                      >
                        <span className="text-[var(--text-muted)]">{line.time}</span>
                        <span
                          className={cn(
                            line.type === "proc" && "italic",
                            line.type === "ok" && "font-semibold"
                          )}
                        >
                          {line.msg}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Terminal */}
                <div
                  className={cn(
                    "bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl overflow-hidden shadow-lg transition-all duration-500",
                    typingDone && "shadow-xl"
                  )}
                  style={{
                    opacity: terminalVisible ? 1 : 0,
                    transform: terminalVisible ? "translateY(0)" : "translateY(16px)",
                    transitionDelay: "80ms",
                  }}
                >
                  {/* Terminal bar */}
                  <div className="flex items-center gap-1.5 px-4 py-3 bg-[var(--bg-tertiary)] border-b border-[var(--border-subtle)]">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                    <span className="ml-2 text-[11px] font-mono text-[var(--text-muted)] tracking-wider">
                      eden — generate
                    </span>
                  </div>
                  {/* Terminal body */}
                  <div className="p-5 flex flex-col gap-0.5">
                    <div className="flex items-center gap-3 h-6">
                      <span className="text-[var(--accent)] font-mono text-sm">$</span>
                      <span className="text-[var(--text-primary)] font-mono text-sm">
                        {cmdText}
                        <span className="inline-block w-2 h-4 bg-[var(--accent)] ml-0.5 animate-cursor-blink rounded-sm" />
                      </span>
                    </div>
                    {RESULT_LINES.slice(0, resultRevealed).map((line, idx) => (
                      <div
                        key={idx}
                        className="pl-6 h-6 flex items-center text-[var(--text-secondary)] font-mono text-xs border-l-2 border-[var(--accent)]/30 bg-[var(--accent)]/5 rounded-r"
                      >
                        {line}
                      </div>
                    ))}
                    {resultRevealed === RESULT_LINES.length && (
                      <div className="mt-2 ml-7 px-3 py-2 bg-[var(--success)]/10 border-l-2 border-[var(--success)] rounded-r text-[var(--success)] font-mono text-sm font-semibold">
                        Environment ready — 4m 12s elapsed
                      </div>
                    )}
                    <div className="flex items-center gap-3 h-6 mt-1">
                      <span className="text-[var(--accent)] font-mono text-sm">$</span>
                      <span className="inline-block w-2 h-4 bg-[var(--accent)] animate-cursor-blink rounded-sm" />
                    </div>
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
              Trusted by engineering teams at
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

        {/* Features Section */}
        <section id="features" className="py-16 px-6">
          <div className="max-w-6xl mx-auto">
            <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-[var(--accent)] mb-3">
              Platform
            </p>
            <h2
              className="text-3xl md:text-4xl font-bold text-[var(--text-primary)] tracking-tight mb-3"
              style={{ letterSpacing: "-0.025em" }}
            >
              From idea to running environment
            </h2>
            <p className="text-[var(--text-secondary)] mb-10 max-w-lg leading-relaxed">
              Eden handles the full lifecycle — design, generation, validation, and export — so
              your team ships faster.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 stagger-children">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="bg-[var(--bg-primary)] border border-[var(--border-subtle)] rounded-2xl p-5 flex flex-col gap-4 card-hover-lift"
                >
                  <div className="w-10 h-10 bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-lg flex items-center justify-center text-[var(--accent)]">
                    <feature.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">
                      {feature.title}
                    </h3>
                    <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-16 px-6 border-t border-[var(--border-subtle)]">
          <div className="max-w-6xl mx-auto">
            <div className="bg-[var(--bg-primary)] border border-[var(--accent)]/20 rounded-2xl p-8 md:p-10 flex flex-col md:flex-row items-center justify-between gap-6">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold text-[var(--text-primary)] mb-2">
                  Ready to ship faster?
                </h2>
                <p className="text-sm text-[var(--text-muted)]">
                  Join teams using Eden to generate environments in minutes, not weeks.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 shrink-0">
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium bg-[var(--accent)] text-white rounded-xl hover:bg-[var(--accent-hover)] transition-colors"
                >
                  Start building free
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
                AI-native environment generation.
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
              © 2026 Eden
            </p>
          </div>
        </footer>
      </main>
    </>
  );
}
