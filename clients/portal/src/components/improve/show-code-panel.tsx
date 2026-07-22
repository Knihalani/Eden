"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeChip } from "@/components/ui/code-chip";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type ShowCodePanelProps = {
  diff?: string | null;
  files?: Array<{ path: string; size?: number }>;
  branch?: string | null;
  commitSha?: string | null;
  emptyLabel?: string;
  className?: string;
};

export function ShowCodePanel({
  diff,
  files,
  branch,
  commitSha,
  emptyLabel = "No code diff yet.",
  className,
}: ShowCodePanelProps) {
  const [mode, setMode] = useState<"formatted" | "unified">("unified");
  const hasDiff = Boolean(diff?.trim());

  return (
    <Panel
      tone="flat"
      padding="md"
      className={cn("space-y-3", className)}
      data-testid="show-code-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">
          Show Code
        </h3>
        {branch ? <CodeChip size="sm">{branch}</CodeChip> : null}
        {commitSha ? <CodeChip size="sm">{commitSha.slice(0, 8)}</CodeChip> : null}
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "formatted" ? "secondary" : "ghost"}
            className="min-h-9"
            onClick={() => setMode("formatted")}
            data-testid="diff-mode-formatted"
          >
            Formatted
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "unified" ? "secondary" : "ghost"}
            className="min-h-9"
            onClick={() => setMode("unified")}
            data-testid="diff-mode-unified"
          >
            Unified
          </Button>
        </div>
      </div>

      {files && files.length > 0 ? (
        <ul className="space-y-1 text-sm text-[var(--text-secondary)]">
          {files.map((f) => (
            <li key={f.path} className="font-mono text-xs">
              {f.path}
              {f.size != null ? (
                <span className="text-[var(--text-muted)]"> · {f.size}B</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!hasDiff ? (
        <p className="text-sm text-[var(--text-muted)]">{emptyLabel}</p>
      ) : (
        <pre
          className={cn(
            "max-h-96 overflow-auto rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 font-mono text-xs text-[var(--text-secondary)]",
            mode === "formatted" && "whitespace-pre-wrap",
          )}
          data-diff-mode={mode}
        >
          {diff}
        </pre>
      )}
    </Panel>
  );
}
