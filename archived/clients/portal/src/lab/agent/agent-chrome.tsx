"use client";

import { StatusChip } from "@/components/ds/primitives";
import type { AgentContextPin } from "@/lab/fixtures/agent-chat";

export type AgentViewMode = "chat" | "history";

export function parseAgentView(view: string | null): AgentViewMode {
  if (view === "history") return "history";
  return "chat";
}

export function PinKindChip({ kind }: { kind: AgentContextPin["kind"] }) {
  const label =
    kind === "trace"
      ? "Trace"
      : kind === "issue"
        ? "Issue"
        : kind === "plan"
          ? "Plan"
          : "Fleet";
  return <StatusChip tone="neutral">{label}</StatusChip>;
}

export function AgentModeNav({
  value,
  onChange,
}: {
  value: AgentViewMode;
  onChange: (next: AgentViewMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Assistant view"
      className="flex gap-1 md:hidden"
    >
      {(
        [
          ["chat", "Chat"],
          ["history", "History"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          className="ds-tab"
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
