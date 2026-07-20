"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FAQS } from "./marketing-data";

export function Faq() {
  const baseId = useId();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <section
      id="faq"
      aria-labelledby={`${baseId}-heading`}
      className="py-20 md:py-28 px-6 border-t border-[var(--border-subtle)]"
    >
      <div className="max-w-3xl mx-auto">
        <h2
          id={`${baseId}-heading`}
          className="marketing-h2 mb-10 text-center"
        >
          Questions before the first trace.
        </h2>
        <div className="flex flex-col gap-2">
          {FAQS.map((f, i) => {
            const open = openFaq === i;
            const panelId = `${baseId}-panel-${i}`;
            const buttonId = `${baseId}-button-${i}`;
            return (
              <div
                key={f.q}
                className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-secondary)] overflow-hidden"
              >
                <h3 className="m-0">
                  <button
                    type="button"
                    id={buttonId}
                    onClick={() => setOpenFaq(open ? null : i)}
                    className="w-full flex items-center justify-between gap-4 min-h-11 px-5 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
                    aria-expanded={open}
                    aria-controls={panelId}
                  >
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {f.q}
                    </span>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "w-4 h-4 text-[var(--text-muted)] transition-transform duration-150 shrink-0 motion-reduce:transition-none",
                        open && "rotate-180 text-[var(--accent)]",
                      )}
                    />
                  </button>
                </h3>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!open}
                  className={cn(!open && "hidden")}
                >
                  <div className="px-5 pb-4 text-sm text-[var(--text-secondary)] leading-relaxed border-t border-[var(--border-subtle)] pt-3">
                    {f.a}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
