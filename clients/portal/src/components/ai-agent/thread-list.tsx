"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { AiSession } from "./types";
import { cn } from "@/lib/utils";

interface ThreadListProps {
  sessions: AiSession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onArchive?: (sessionId: string) => void;
  className?: string;
}

export function ThreadList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
  onArchive,
  className,
}: ThreadListProps) {
  const t = useTranslations("ai.threads");

  const active = sessions.filter((s) => !s.archived);

  return (
    <aside
      className={cn("flex flex-col border-r border-[var(--border-subtle)]", className)}
      aria-label={t("ariaLabel")}
    >
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">{t("title")}</span>
        <Button size="sm" variant="ghost" onClick={onNew} aria-label={t("new")}>
          +
        </Button>
      </div>
      <ul className="flex-1 overflow-y-auto py-1">
        {active.length === 0 && (
          <li className="px-3 py-2 text-xs text-[var(--text-muted)]">{t("empty")}</li>
        )}
        {active.map((session) => (
          <li key={session.session_id}>
            <button
              type="button"
              onClick={() => onSelect(session.session_id)}
              className={cn(
                "w-full px-3 py-2 text-left text-xs hover:bg-[var(--bg-tertiary)]",
                activeSessionId === session.session_id
                  ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                  : "text-[var(--text-secondary)]",
              )}
            >
              <span className="block truncate">
                {session.title || t("untitled")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
