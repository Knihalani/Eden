import Link from "next/link";
import {
  ArrowRight,
  FileText,
  MessageSquare,
  Search,
  Crosshair,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ASSISTANT_TURNS } from "./marketing-data";
import { SignedInGate } from "./SignedInGate";

export function AssistantPreview() {
  return (
    <section
      id="assistant"
      className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30"
    >
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 order-2 lg:order-1">
            <div className="border border-[var(--border-default)] rounded-xl overflow-hidden bg-[var(--bg-base)]">
              <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border-subtle)]">
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    Eden assistant
                  </span>
                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Workspace · cited to traces
                  </span>
                </div>
              </div>
              <div className="p-5 md:p-6 flex flex-col gap-4">
                {ASSISTANT_TURNS.map((turn, idx) => (
                  <div
                    key={idx}
                    className={cn("flex gap-3", turn.role === "user" ? "" : "pl-2")}
                  >
                    {turn.role === "assistant" ? (
                      <div
                        aria-hidden
                        className="w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0"
                      >
                        <span className="text-[10px] font-mono text-[var(--accent)]">
                          E
                        </span>
                      </div>
                    ) : (
                      <div
                        aria-hidden
                        className="w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0"
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                        {turn.body}
                      </p>
                      {"cites" in turn && turn.cites && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                            cited
                          </span>
                          {turn.cites.map((c) => (
                            <span
                              key={c}
                              className="text-[11px] font-mono text-[var(--accent)]"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div className="pl-10">
                  <SignedInGate
                    signedIn={
                      <Link
                        href="/improve"
                        className="inline-flex items-center gap-1.5 min-h-11 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] border border-[var(--border-default)] rounded-lg px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
                      >
                        Open the Improve inbox
                        <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                      </Link>
                    }
                    signedOut={
                      <Link
                        href="/sign-up"
                        className="inline-flex items-center gap-1.5 min-h-11 text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] border border-[var(--border-default)] rounded-lg px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
                      >
                        Start free to open Improve
                        <ArrowRight className="w-3.5 h-3.5" aria-hidden />
                      </Link>
                    }
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 px-3 py-2.5 border-t border-[var(--border-subtle)]">
                <span className="text-[var(--accent)] font-mono text-sm shrink-0" aria-hidden>
                  ›
                </span>
                <span className="text-sm text-[var(--text-muted)] font-mono">
                  Ask anything about your traces…
                </span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 order-1 lg:order-2">
            <h2 className="marketing-h2 mb-4">
              Ask your data.
              <br />
              <span className="text-[var(--accent)]">Cited answers.</span>
            </h2>
            <p className="text-[var(--text-secondary)] leading-relaxed mb-5">
              A persistent assistant in every portal view. It queries your
              traces and eval records — not the public web — and cites the ID
              behind every claim.
            </p>
            <ul className="flex flex-col gap-3">
              {[
                {
                  icon: Search,
                  body: "Queries your traces, spans, and eval records — not the public web",
                },
                {
                  icon: FileText,
                  body: "Every answer cites the trace ID or eval record behind the claim",
                },
                {
                  icon: Crosshair,
                  body: "Surfaces an Improve draft when a regression looks fixable — you still open the PR",
                },
              ].map((b) => {
                const Icon = b.icon;
                return (
                  <li
                    key={b.body}
                    className="flex items-start gap-3 text-sm text-[var(--text-secondary)]"
                  >
                    <Icon
                      className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0"
                      aria-hidden
                    />
                    <span className="leading-relaxed">{b.body}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
