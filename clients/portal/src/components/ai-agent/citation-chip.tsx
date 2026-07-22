"use client";

import Link from "next/link";
import { Tag } from "@/components/ui/tag";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { citationHref, citationLabel, type CitationTarget } from "@/lib/citation-href";
import { cn } from "@/lib/utils";

interface CitationChipProps {
  citation: CitationTarget;
  onRemove?: () => void;
  className?: string;
}

export function CitationChip({ citation, onRemove, className }: CitationChipProps) {
  const href = citationHref(citation);
  const label = citationLabel(citation);

  if (onRemove) {
    return (
      <Tag
        onRemove={onRemove}
        className={cn("font-mono text-xs", className)}
        title={citation.id}
      >
        <Link href={href} className="hover:underline" onClick={(e) => e.stopPropagation()}>
          {label}
        </Link>
      </Tag>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)]",
        "px-1.5 py-0.5 font-mono text-xs text-[var(--accent)] hover:bg-[var(--accent-faint)]",
        FOCUS_RING_CLASS,
        className,
      )}
      title={citation.id}
    >
      {label}
    </Link>
  );
}
