import { ArrowRight, Check, Search, Workflow, GitBranch, Crosshair } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

export function ImproveSpotlight() {
  return (
    <section id="improve" className="py-20 md:py-28 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-5">
            <h2 className="marketing-h2 mb-4">
              From regression detected to{" "}
              <span className="text-[var(--accent)]">patch ready for review</span>
            </h2>
            <p className="text-[var(--text-secondary)] mb-5 leading-relaxed">
              Traces alone are not a fix. When a judge score drifts, Eden queues
              a draft with failing traces, root cause, and eval results. You
              decide whether to open the PR — Eden never opens one on its own.
            </p>
            <ul className="flex flex-col gap-3 mb-7">
              {[
                "Root-cause hypotheses cited to trace IDs and eval records",
                "Prompt or code patch, then local evals against your suite",
                "Inbox queue — humans decide what ships",
                "Audit trail: who reviewed, who opened the PR, who merged",
              ].map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-3 text-sm text-[var(--text-secondary)]"
                >
                  <Check
                    className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0"
                    aria-hidden
                  />
                  <span className="leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 min-h-11 text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] rounded-md"
            >
              Quickstart
              <ArrowRight className="w-4 h-4" aria-hidden />
            </a>
          </div>

          <div className="lg:col-span-7">
            <div className="border border-[var(--border-default)] rounded-xl overflow-hidden bg-[var(--bg-base)]">
              <div className="px-4 py-2.5 border-b border-[var(--border-subtle)]">
                <span className="text-[11px] font-mono text-[var(--text-muted)]">
                  eden — improve · ready for review
                </span>
              </div>
              <div className="p-5 md:p-6 font-mono text-[13px]">
                <div className="flex flex-wrap items-center gap-3 pb-4 border-b border-[var(--border-subtle)]">
                  <span className="text-[var(--text-primary)] font-semibold">
                    judge.score drift · plan: tool_call.2
                  </span>
                  <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] border border-[var(--border-subtle)] px-2 py-0.5 rounded">
                    awaiting review
                  </span>
                </div>
                <div className="flex flex-col mt-4">
                  {[
                    {
                      icon: Search,
                      label: "Read failing traces",
                      meta: "247 traces, last 6h",
                      tone: "default" as const,
                    },
                    {
                      icon: Crosshair,
                      label: "Hypothesised root cause",
                      meta: "prompt brittleness on tool_call.2 — conf 0.78",
                      tone: "accent" as const,
                    },
                    {
                      icon: Workflow,
                      label: "Edited prompts/system.md",
                      meta: "+12 −4",
                      tone: "default" as const,
                    },
                    {
                      icon: Check,
                      label: "Ran eden evals",
                      meta: "smoke ✓ · quality ✓ · regression ✓",
                      tone: "ok" as const,
                    },
                    {
                      icon: GitBranch,
                      label: "Queued for review",
                      meta: "patch ready — you open the PR",
                      tone: "ok" as const,
                    },
                  ].map((step, idx, arr) => {
                    const Icon = step.icon;
                    const isLast = idx === arr.length - 1;
                    return (
                      <div key={step.label} className="flex gap-4">
                        <div className="flex flex-col items-center pt-0.5">
                          <div
                            className={cn(
                              "w-7 h-7 rounded-md flex items-center justify-center border",
                              step.tone === "ok" &&
                                "bg-[var(--bg-tertiary)] border-[var(--border-default)]",
                              step.tone === "accent" &&
                                "bg-[var(--accent)]/10 border-[var(--accent)]/40",
                              step.tone === "default" &&
                                "bg-[var(--bg-secondary)] border-[var(--border-subtle)]",
                            )}
                          >
                            <Icon
                              className={cn(
                                "w-3.5 h-3.5",
                                step.tone === "ok" && "text-[var(--text-primary)]",
                                step.tone === "accent" && "text-[var(--accent)]",
                                step.tone === "default" && "text-[var(--text-muted)]",
                              )}
                              aria-hidden
                            />
                          </div>
                          {!isLast && (
                            <div className="w-px flex-1 bg-[var(--border-subtle)] my-1" />
                          )}
                        </div>
                        <div className="pb-5 pt-1.5 min-w-0 flex-1">
                          <div className="text-sm text-[var(--text-primary)]">
                            {step.label}
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
  );
}
