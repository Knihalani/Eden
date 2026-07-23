"use client";

import Link from "next/link";
import {
  labCitationHref,
  type AgentCitation,
} from "@/lab/fixtures/agent-chat";

export function AgentCitationChip({ citation }: { citation: AgentCitation }) {
  return (
    <Link
      href={labCitationHref(citation)}
      className="type-mono inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-2 py-1 !text-[0.6875rem] !text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      title={`Open ${citation.kind} ${citation.label}`}
    >
      <span className="type-label capitalize !text-[var(--text-secondary)]">
        {citation.kind}
      </span>
      <span className="max-w-[12rem] truncate">{citation.label}</span>
    </Link>
  );
}

export function AgentCitationRow({ items }: { items: AgentCitation[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((c) => (
        <AgentCitationChip key={`${c.kind}-${c.id}`} citation={c} />
      ))}
    </div>
  );
}
