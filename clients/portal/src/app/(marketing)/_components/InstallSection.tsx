"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check } from "lucide-react";
import { CodeChip } from "@/components/ui/code-chip";
import { cn } from "@/lib/utils";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { INSTALL_BLOCKS } from "./marketing-data";

type InstallTabId = (typeof INSTALL_BLOCKS)[number]["id"];

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]";

export function InstallSection() {
  const [activeTab, setActiveTab] = useState<InstallTabId>("gateway");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<InstallTabId, HTMLButtonElement | null>>>(
    {},
  );
  const activeBlock =
    INSTALL_BLOCKS.find((b) => b.id === activeTab) ?? INSTALL_BLOCKS[0];
  const panelId = `${baseId}-panel`;

  function activateTab(id: InstallTabId, focus = false) {
    setActiveTab(id);
    if (focus) {
      requestAnimationFrame(() => tabRefs.current[id]?.focus());
    }
  }

  async function copyCode(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // noop
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const ids = INSTALL_BLOCKS.map((b) => b.id);
    const i = ids.indexOf(activeTab);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      activateTab(ids[(i + 1) % ids.length]!, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      activateTab(ids[(i - 1 + ids.length) % ids.length]!, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      activateTab(ids[0]!, true);
    } else if (e.key === "End") {
      e.preventDefault();
      activateTab(ids[ids.length - 1]!, true);
    }
  }

  return (
    <section id="install" className="py-12 md:py-16 px-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-10 items-start">
        <div className="lg:col-span-4 lg:sticky lg:top-24">
          <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)] mb-3">
            Install
          </p>
          <h2 className="marketing-h2 mb-4">
            One line.
            <br />
            Every call captured.
          </h2>
          <p className="text-[var(--text-secondary)] leading-relaxed mb-6">
            Fastest path: point the OpenAI SDK at the gateway. Or drop in{" "}
            <code className="text-[var(--text-primary)] font-mono text-[13px]">
              eden-sdk
            </code>{" "}
            /{" "}
            <code className="text-[var(--text-primary)] font-mono text-[13px]">
              @eden-ai/sdk
            </code>
            . Same outcome — every call traced and ready for{" "}
            <CodeChip>Traces</CodeChip>.
          </p>
          <ul className="flex flex-col gap-2.5 text-sm">
            {[
              "Gateway: base_url + org headers — keep the OpenAI SDK you already use",
              "SDK: configure → instrument / wrap for spans and tool calls",
              "Confirm with doctor, then open Traces in the portal",
            ].map((b) => (
              <li
                key={b}
                className="flex items-start gap-2 text-[var(--text-secondary)]"
              >
                <Check
                  className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0"
                  aria-hidden
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="lg:col-span-8">
          <div className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl overflow-hidden">
            <div className="flex flex-col gap-2 px-2 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)] sm:flex-row sm:items-center sm:gap-2">
              <div
                role="tablist"
                aria-label="Installation options"
                onKeyDown={onTabKeyDown}
                className="flex flex-wrap items-center gap-1 min-w-0 flex-1"
              >
                {INSTALL_BLOCKS.map((b) => {
                  const selected = activeTab === b.id;
                  return (
                    <button
                      key={b.id}
                      ref={(el) => {
                        tabRefs.current[b.id] = el;
                      }}
                      id={`${baseId}-tab-${b.id}`}
                      role="tab"
                      type="button"
                      aria-selected={selected}
                      aria-controls={panelId}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => activateTab(b.id)}
                      className={cn(
                        "min-h-11 px-3 text-xs font-mono rounded-md transition-colors",
                        focusRing,
                        selected
                          ? "bg-[var(--bg-base)] text-[var(--accent)] border border-[var(--border-subtle)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent",
                      )}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => copyCode(activeBlock.id, activeBlock.code)}
                aria-label={`Copy ${activeBlock.label} snippet`}
                className={cn(
                  "inline-flex min-h-11 items-center justify-center gap-1.5 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-transparent border border-[var(--border-subtle)] rounded-md transition-colors w-full sm:w-auto sm:shrink-0",
                  focusRing,
                )}
              >
                {copiedId === activeBlock.id ? (
                  <>
                    <Check
                      className="w-3.5 h-3.5 text-[var(--terminal)]"
                      aria-hidden
                    />
                    Copied
                  </>
                ) : (
                  "Copy"
                )}
              </button>
            </div>
            <p className="px-5 pt-3 text-[11px] font-mono text-[var(--text-muted)]">
              {activeBlock.hint}
            </p>
            <pre
              id={panelId}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-${activeBlock.id}`}
              tabIndex={0}
              className={cn(
                "bg-[var(--code-surface)] text-[var(--text-primary)] px-5 pb-5 pt-3 md:px-6 md:pb-6 text-[13px] font-mono overflow-x-auto leading-relaxed",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
              )}
            >
              <code>{activeBlock.code}</code>
            </pre>
            <div aria-live="polite" className="sr-only">
              {copiedId ? "Snippet copied to clipboard" : ""}
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)]">
              <span>Then open Traces.</span>
              <a
                href={DOCS_QUICKSTART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "ml-auto min-h-11 inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)] px-1",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]",
                )}
              >
                Quickstart
                <ArrowRight className="w-3 h-3" aria-hidden />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
