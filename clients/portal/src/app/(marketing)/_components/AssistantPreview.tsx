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
      className="border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]/30 px-space-5 py-20 md:py-28"
    >
      <div className="mx-auto max-w-7xl">
        <div className="grid grid-cols-1 items-center gap-space-7 lg:grid-cols-12 lg:gap-space-8">
          <div className="order-2 lg:order-1 lg:col-span-7">
            <div className="overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)]">
              <div className="flex items-center gap-space-2 border-b border-[var(--border-subtle)] px-space-4 py-space-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold text-[var(--text-primary)]">
                    Eden assistant
                  </span>
                  <span className="font-mono text-2xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                    Workspace · cited to traces
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-space-4 p-space-5 md:p-space-6">
                {ASSISTANT_TURNS.map((turn, idx) => (
                  <div
                    key={idx}
                    className={cn("flex gap-space-3", turn.role === "user" ? "" : "pl-space-2")}
                  >
                    {turn.role === "assistant" ? (
                      <div
                        aria-hidden
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]"
                      >
                        <span className="font-mono text-2xs text-[var(--accent)]">
                          E
                        </span>
                      </div>
                    ) : (
                      <div
                        aria-hidden
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-tertiary)]"
                      >
                        <MessageSquare className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-relaxed text-[var(--text-primary)]">
                        {turn.body}
                      </p>
                      {"cites" in turn && turn.cites && (
                        <div className="mt-space-2 flex flex-wrap items-center gap-space-2">
                          <span className="font-mono text-2xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
                            cited
                          </span>
                          {turn.cites.map((c) => (
                            <span
                              key={c}
                              className="font-mono text-[11px] text-[var(--accent)]"
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
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-space-3 py-space-2 text-sm text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
                      >
                        Open the Improve inbox
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    }
                    signedOut={
                      <Link
                        href="/sign-up"
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-space-3 py-space-2 text-sm text-[var(--accent)] transition-colors hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)]"
                      >
                        Start free to open Improve
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    }
                  />
                </div>
              </div>
              <div className="flex items-center gap-space-2 border-t border-[var(--border-subtle)] px-space-3 py-space-3">
                <span className="shrink-0 font-mono text-sm text-[var(--accent)]" aria-hidden>
                  ›
                </span>
                <span className="font-mono text-sm text-[var(--text-muted)]">
                  Ask anything about your traces…
                </span>
              </div>
            </div>
          </div>

          <div className="order-1 lg:order-2 lg:col-span-5">
            <h2 className="marketing-h2 mb-space-4">
              Ask your data.
              <br />
              <span className="text-[var(--accent)]">Cited answers.</span>
            </h2>
            <p className="mb-space-5 leading-relaxed text-[var(--text-secondary)]">
              A persistent assistant in every portal view. It queries your
              traces and eval records — not the public web — and cites the ID
              behind every claim.
            </p>
            <ul className="flex flex-col gap-space-3">
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
                    className="flex items-start gap-space-3 text-sm text-[var(--text-secondary)]"
                  >
                    <Icon
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
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
