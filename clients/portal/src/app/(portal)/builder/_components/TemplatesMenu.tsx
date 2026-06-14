"use client";

/**
 * TemplatesMenu — dropdown that lets the user one-click load a
 * pre-built starter DAG (Coding Eval, Tool-Use Eval, Memory
 * Stress, Reflexion Loop, Multi-Scenario Sweep). The menu sits
 * in the toolbar next to the Recent dropdown and uses the same
 * light-theme chrome as the rest of the page.
 *
 * Clicking a template confirms with the user (since it overwrites
 * the current graph) and then calls ``onPick`` with a fresh
 * { graphName, nodes, edges } from the template's ``build()``.
 */

import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TEMPLATES, type BuilderTemplate } from "../_lib/templates";

export interface TemplatesMenuProps {
  onPick: (template: BuilderTemplate) => void;
}

export function TemplatesMenu({ onPick }: TemplatesMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="templates-menu-button"
      >
        <Sparkles className="w-3.5 h-3.5" />
        Templates
        <ChevronDown className="w-3 h-3" />
      </Button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-80 z-30 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg"
          role="menu"
        >
          <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Starter templates
            </h3>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              One-click to start. You can edit anything afterwards.
            </p>
          </div>
          <ul className="py-1 max-h-96 overflow-y-auto">
            {TEMPLATES.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] flex items-start gap-2.5"
                  onClick={() => {
                    setOpen(false);
                    onPick(t);
                  }}
                  data-testid={`template-${t.id}`}
                >
                  <span
                    className="text-lg shrink-0 mt-0.5"
                    aria-hidden="true"
                  >
                    {t.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--text-primary)]">
                      {t.name}
                    </span>
                    <span className="block text-[11px] text-[var(--text-muted)] mt-0.5 line-clamp-2">
                      {t.description}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
