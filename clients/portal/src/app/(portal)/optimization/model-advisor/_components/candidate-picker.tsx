"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CANDIDATES,
  type CandidateOption,
  optKey,
} from "./advisor-candidates";

export function CandidatePicker({ selected, onChange }: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return CANDIDATES;
    return CANDIDATES.filter((c) =>
      c.label.toLowerCase().includes(f) ||
      c.provider.toLowerCase().includes(f) ||
      c.modelId.toLowerCase().includes(f),
    );
  }, [filter]);

  const selectedOpts = selected
    .map((k) => CANDIDATES.find((c) => optKey(c) === k))
    .filter((x): x is CandidateOption => x != null);

  function toggle(opt: CandidateOption) {
    const k = optKey(opt);
    if (selected.includes(k)) {
      onChange(selected.filter((s) => s !== k));
    } else {
      onChange([...selected, k]);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2 text-left text-sm hover:border-[var(--border-strong)]"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedOpts.length === 0 && (
            <span className="text-[var(--text-muted)]">Select candidate models…</span>
          )}
          {selectedOpts.slice(0, 4).map((o) => (
            <Badge
              key={optKey(o)}
              variant="outline"
              className={cn("border text-2xs", o.color)}
            >
              {o.label}
            </Badge>
          ))}
          {selectedOpts.length > 4 && (
            <span className="text-xs text-[var(--text-muted)]">
              +{selectedOpts.length - 4} more
            </span>
          )}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform", open && "rotate-180")} />
      </button>
      <>
        {open && (
          <div
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-sm"
          >
            <div className="border-b border-[var(--border-default)] p-2">
              <Input
                autoFocus
                placeholder="Filter models…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto py-1">
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-[var(--text-muted)]">No matches.</li>
              )}
              {filtered.map((o) => {
                const k = optKey(o);
                const isSelected = selected.includes(k);
                return (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => toggle(o)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                        isSelected ? "bg-[var(--accent-faint)]" : "hover:bg-[var(--bg-tertiary)]",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn(
                          "inline-flex h-4 w-4 items-center justify-center rounded border",
                          isSelected
                            ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                            : "border-[var(--border-strong)]",
                        )}>
                          {isSelected && <span className="text-2xs">✓</span>}
                        </span>
                        <span className="truncate text-[var(--text-primary)]">{o.label}</span>
                      </div>
                      <Badge variant="outline" className={cn("shrink-0 border text-2xs", o.color)}>
                        {o.tier}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </>
    </div>
  );
}
