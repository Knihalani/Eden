"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { AgentActionCard } from "@/lab/fixtures/agent-chat";
import { cn } from "@/lib/utils";

export function AgentActionCards({ items }: { items: AgentActionCard[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map((card) => (
        <li key={`${card.kind}-${card.href}-${card.title}`}>
          <Link
            href={card.href}
            className={cn(
              "group flex h-full flex-col justify-between gap-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-3.5 py-3 transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-muted)]",
              card.primary && "border-[var(--accent)]/40",
            )}
          >
            <div className="min-w-0">
              <p className="type-ui flex items-center gap-1.5 text-[var(--text)]">
                {card.title}
                <ArrowUpRight
                  className="h-3.5 w-3.5 shrink-0 text-[var(--text-faint)] transition-colors group-hover:text-[var(--accent)]"
                  aria-hidden
                />
              </p>
              {card.body ? (
                <p className="type-meta mt-1 text-[var(--text-secondary)] leading-snug">
                  {card.body}
                </p>
              ) : null}
            </div>
            <span
              className={cn(
                "type-meta",
                card.primary ? "text-[var(--accent)]" : "text-[var(--text-faint)]",
              )}
            >
              {card.primary ? "Primary" : "Open"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
