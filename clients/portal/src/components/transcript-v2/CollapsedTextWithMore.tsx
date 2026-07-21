"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function CollapsedTextWithMore({
  text,
  lines = 4,
  previewLines,
  className,
}: {
  text: string;
  lines?: number;
  previewLines?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [needsClamp, setNeedsClamp] = useState(text.length > 160);
  const textRef = useRef<HTMLParagraphElement>(null);
  const clampLines = previewLines ?? lines;
  const clampClass =
    clampLines <= 1 ? "line-clamp-1" : clampLines <= 2 ? "line-clamp-2" : "line-clamp-4";

  useEffect(() => {
    if (text.length > 160) {
      setNeedsClamp(true);
      return;
    }
    if (expanded) return;
    const el = textRef.current;
    if (!el) return;
    setNeedsClamp(el.scrollHeight > el.clientHeight + 1);
  }, [text, clampLines, expanded]);

  return (
    <div className={cn("min-w-0", className)} data-testid="collapsed-text">
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap break-words text-xs text-[var(--text-secondary)]",
          !expanded && clampClass,
        )}
      >
        {text}
      </p>
      {needsClamp ? (
        <button
          type="button"
          className="mt-space-1 text-2xs font-medium text-[var(--accent)] hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}
