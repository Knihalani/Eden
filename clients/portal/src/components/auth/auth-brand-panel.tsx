"use client";

import { Layers, Zap, ShieldCheck, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

const features = [
  {
    icon: GitBranch,
    text: "Sequential multi-agent reasoning",
  },
  {
    icon: Zap,
    text: "Real-time SSE streaming output",
  },
  {
    icon: ShieldCheck,
    text: "Production-ready code output",
  },
];

export function AuthBrandPanel() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg-primary)]">
      {/* Animated mesh gradient background — pure CSS */}
      <div className="auth-mesh-gradient" aria-hidden="true" />

      {/* Subtle grid overlay */}
      <div className="auth-grid-overlay" aria-hidden="true" />

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-center min-h-screen px-14 py-12">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-12">
          <div className="auth-logo-mark">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <span className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">
            eden
          </span>
        </div>

        {/* Hero */}
        <h1 className="auth-hero-line mb-4">
          Build AI Agent<br />
          <span className="text-[var(--accent)]">Environments.</span>
        </h1>

        <p className="text-lg text-[var(--text-secondary)] max-w-md mb-10 leading-relaxed">
          Describe your environment in plain English. Eden&apos;s multi-agent pipeline designs,
          generates, and validates — producing production-ready code without glue.
        </p>

        {/* Pipeline mini-visualizer */}
        <div className="flex items-center gap-3 mb-10 flex-wrap">
          {["Plan", "Verify", "Generate", "Deliver"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className={cn("flex flex-col items-center gap-1.5", i === 0 ? "opacity-100" : "opacity-40")}>
                <div className={cn("auth-pipeline-dot", i === 0 && "animate-pulse")} />
                <span className="text-[10px] font-mono tracking-widest uppercase text-[var(--text-muted)]">
                  {label}
                </span>
              </div>
              {i < 3 && (
                <span className="text-[var(--accent)]/30 text-lg mt-[-10px]">→</span>
              )}
            </div>
          ))}
        </div>

        {/* Feature list */}
        <div className="flex flex-col gap-3">
          {features.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
              <div className="auth-feature-icon">
                <Icon className="w-3.5 h-3.5" />
              </div>
              {text}
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .auth-mesh-gradient {
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(ellipse 80% 60% at 50% 40%, rgba(70, 160, 220, 0.12) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 20% 80%, rgba(72, 160, 140, 0.07) 0%, transparent 60%),
            radial-gradient(ellipse 40% 30% at 85% 15%, rgba(100, 80, 200, 0.05) 0%, transparent 60%);
          animation: meshDrift 20s ease-in-out infinite;
        }

        @keyframes meshDrift {
          0%, 100% {
            background:
              radial-gradient(ellipse 80% 60% at 50% 40%, rgba(70, 160, 220, 0.12) 0%, transparent 70%),
              radial-gradient(ellipse 50% 40% at 20% 80%, rgba(72, 160, 140, 0.07) 0%, transparent 60%),
              radial-gradient(ellipse 40% 30% at 85% 15%, rgba(100, 80, 200, 0.05) 0%, transparent 60%);
          }
          33% {
            background:
              radial-gradient(ellipse 80% 60% at 45% 45%, rgba(70, 160, 220, 0.10) 0%, transparent 70%),
              radial-gradient(ellipse 50% 40% at 25% 75%, rgba(72, 160, 140, 0.08) 0%, transparent 60%),
              radial-gradient(ellipse 40% 30% at 80% 20%, rgba(100, 80, 200, 0.06) 0%, transparent 60%);
          }
          66% {
            background:
              radial-gradient(ellipse 80% 60% at 55% 35%, rgba(70, 160, 220, 0.08) 0%, transparent 70%),
              radial-gradient(ellipse 50% 40% at 15% 85%, rgba(72, 160, 140, 0.06) 0%, transparent 60%),
              radial-gradient(ellipse 40% 30% at 90% 10%, rgba(100, 80, 200, 0.04) 0%, transparent 60%);
          }
        }

        .auth-grid-overlay {
          position: absolute;
          inset: 0;
          z-index: 1;
          background-image:
            linear-gradient(rgba(100, 120, 160, 0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(100, 120, 160, 0.04) 1px, transparent 1px);
          background-size: 60px 60px;
        }

        .auth-logo-mark {
          width: 52px;
          height: 52px;
          background: var(--accent);
          border-radius: var(--radius-lg);
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 32px oklch(70% 0.16 200 / 0.4), 0 0 64px oklch(70% 0.16 200 / 0.2);
          flex-shrink: 0;
        }

        .auth-hero-line {
          font-size: clamp(40px, 5vw, 64px);
          font-weight: 700;
          line-height: 1;
          letter-spacing: -0.05em;
          color: var(--text-primary);
        }

        .auth-feature-icon {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          background: oklch(70% 0.16 200 / 0.1);
          border: 1px solid oklch(70% 0.16 200 / 0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          flex-shrink: 0;
        }

        .auth-pipeline-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: oklch(70% 0.16 200);
          box-shadow: 0 0 8px oklch(70% 0.16 200 / 0.6);
        }
      `}</style>
    </div>
  );
}
