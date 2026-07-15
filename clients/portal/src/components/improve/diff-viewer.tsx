"use client";

import { useMemo, useState } from "react";
import { Check, Columns2, Copy, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface DiffLine {
  type: "context" | "add" | "remove" | "header" | "meta";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export function parseDiff(diff: string): DiffHunk[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let i = 0;
  let oldLineNum = 0;
  let newLineNum = 0;
  while (i < lines.length && lines[i].startsWith("---")) i++;
  while (i < lines.length && lines[i].startsWith("+++")) i++;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!m) {
      i++;
      continue;
    }
    oldLineNum = parseInt(m[1], 10);
    const oldCount = m[2] ? parseInt(m[2], 10) : 1;
    newLineNum = parseInt(m[3], 10);
    const newCount = m[4] ? parseInt(m[4], 10) : 1;
    i++;
    const diffLines: DiffLine[] = [];
    let o = oldLineNum;
    let n = newLineNum;
    let oCount = 0;
    let nCount = 0;
    while (i < lines.length && (oCount < oldCount || nCount < newCount)) {
      const l = lines[i];
      if (l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++")) break;
      if (l.startsWith("+")) {
        diffLines.push({ type: "add", oldLine: null, newLine: n, content: l.slice(1) });
        n++;
        nCount++;
      } else if (l.startsWith("-")) {
        diffLines.push({ type: "remove", oldLine: o, newLine: null, content: l.slice(1) });
        o++;
        oCount++;
      } else if (l.startsWith(" ") || l === "") {
        diffLines.push({
          type: "context",
          oldLine: o,
          newLine: n,
          content: l.startsWith(" ") ? l.slice(1) : "",
        });
        o++;
        n++;
        oCount++;
        nCount++;
      } else {
        i++;
        continue;
      }
      i++;
    }
    hunks.push({
      oldStart: oldLineNum,
      oldLines: oldCount,
      newStart: newLineNum,
      newLines: newCount,
      header: line,
      lines: diffLines,
    });
  }
  return hunks;
}

function pairDiffLines(
  hunk: DiffHunk,
): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  const queue: DiffLine[] = [...hunk.lines];
  while (queue.length > 0) {
    const l = queue[0];
    if (l.type === "context") {
      pairs.push({ left: l, right: l });
      queue.shift();
    } else if (l.type === "remove") {
      const next = queue[1];
      if (next && next.type === "add") {
        pairs.push({ left: l, right: next });
        queue.shift();
        queue.shift();
      } else {
        pairs.push({ left: l, right: null });
        queue.shift();
      }
    } else if (l.type === "add") {
      const next = queue[1];
      if (next && next.type === "remove") {
        pairs.push({ left: next, right: l });
        queue.shift();
        queue.shift();
      } else {
        pairs.push({ left: null, right: l });
        queue.shift();
      }
    } else {
      queue.shift();
    }
  }
  return pairs;
}

function tokenise(s: string): string[] {
  return s.split(/(\s+|[^\w\s])/).filter(Boolean);
}

function wordDiff(
  left: string,
  right: string,
): {
  left: Array<{ text: string; changed: boolean }>;
  right: Array<{ text: string; changed: boolean }>;
} {
  const lTokens = tokenise(left);
  const rTokens = tokenise(right);
  const rSet = new Set(rTokens);
  const lSet = new Set(lTokens);
  return {
    left: lTokens.map((t) => ({ text: t, changed: !rSet.has(t) })),
    right: rTokens.map((t) => ({ text: t, changed: !lSet.has(t) })),
  };
}

function UnifiedHunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {hunk.lines.map((l, i) => {
        const cls = cn(
          "flex px-3 py-0.5",
          l.type === "add" && "bg-[var(--terminal)]/5 text-[var(--terminal)]",
          l.type === "remove" && "bg-[var(--error)]/5 text-[var(--error)]",
          l.type === "context" && "text-[var(--text-muted)]",
        );
        const prefix = l.type === "add" ? "+" : l.type === "remove" ? "-" : " ";
        const lineNum =
          l.type === "remove" ? l.oldLine : l.type === "add" ? l.newLine : l.newLine;
        return (
          <div key={i} className={cls}>
            <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
              {lineNum ?? ""}
            </span>
            <span className="select-none w-3 text-[var(--text-secondary)]">{prefix}</span>
            <span className="flex-1 whitespace-pre-wrap break-all">{l.content}</span>
          </div>
        );
      })}
    </div>
  );
}

function SplitHunk({ hunk }: { hunk: DiffHunk }) {
  const pairs = pairDiffLines(hunk);
  return (
    <div>
      {pairs.map((p, i) => {
        let left: React.ReactNode = null;
        let right: React.ReactNode = null;
        if (p.left && p.right && p.left.type === "remove" && p.right.type === "add") {
          const wd = wordDiff(p.left.content, p.right.content);
          left = (
            <span>
              {wd.left.map((tok, ti) => (
                <span
                  key={ti}
                  className={cn(tok.changed && "bg-[var(--error)]/20 rounded-sm")}
                >
                  {tok.text}
                </span>
              ))}
            </span>
          );
          right = (
            <span>
              {wd.right.map((tok, ti) => (
                <span
                  key={ti}
                  className={cn(tok.changed && "bg-[var(--terminal)]/20 rounded-sm")}
                >
                  {tok.text}
                </span>
              ))}
            </span>
          );
        } else {
          left = p.left ? <span>{p.left.content}</span> : null;
          right = p.right ? <span>{p.right.content}</span> : null;
        }
        return (
          <div key={i} className="grid grid-cols-2 divide-x divide-[var(--border-default)]/50">
            <div
              className={cn(
                "flex px-3 py-0.5",
                p.left?.type === "remove" && "bg-[var(--error)]/5 text-[var(--error)]",
                p.left?.type === "context" && "text-[var(--text-muted)]",
                !p.left && "bg-[var(--bg-base)]/30",
              )}
            >
              <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
                {p.left?.oldLine ?? ""}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all">{left}</span>
            </div>
            <div
              className={cn(
                "flex px-3 py-0.5",
                p.right?.type === "add" && "bg-[var(--terminal)]/5 text-[var(--terminal)]",
                p.right?.type === "context" && "text-[var(--text-muted)]",
                !p.right && "bg-[var(--bg-base)]/30",
              )}
            >
              <span className="text-[var(--text-secondary)] select-none w-8 text-right pr-2">
                {p.right?.newLine ?? ""}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all">{right}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DiffViewer({
  diff,
  diffMode,
  onModeChange,
  emptyMessage = "No diff generated yet.",
}: {
  diff: string;
  diffMode: "unified" | "split";
  onModeChange: (m: "unified" | "split") => void;
  emptyMessage?: string;
}) {
  const hunks = useMemo(() => parseDiff(diff), [diff]);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  if (hunks.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)] italic p-6 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg text-center">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="inline-flex bg-[var(--bg-base)] border border-[var(--border-default)] rounded-md p-0.5">
          <button
            type="button"
            onClick={() => onModeChange("unified")}
            aria-pressed={diffMode === "unified"}
            className={cn(
              "px-2.5 py-1 text-xs rounded flex items-center gap-1.5",
              diffMode === "unified"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-muted)]",
            )}
          >
            <Rows3 className="h-3 w-3" />
            Unified
          </button>
          <button
            type="button"
            onClick={() => onModeChange("split")}
            aria-pressed={diffMode === "split"}
            className={cn(
              "px-2.5 py-1 text-xs rounded flex items-center gap-1.5",
              diffMode === "split"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-muted)]",
            )}
          >
            <Columns2 className="h-3 w-3" />
            Split
          </button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          aria-label={copied ? "Copied diff to clipboard" : "Copy diff to clipboard"}
        >
          {copied ? (
            <Check className="h-4 w-4 text-[var(--terminal)]" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <div className="text-xs font-mono leading-relaxed bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg overflow-hidden">
        {hunks.map((h, hi) => (
          <div key={hi} className="border-b border-[var(--border-default)]/50 last:border-0">
            <div className="px-3 py-1 bg-[var(--accent)]/5 text-[var(--accent)] text-[10px]">
              {h.header}
            </div>
            {diffMode === "unified" ? <UnifiedHunk hunk={h} /> : <SplitHunk hunk={h} />}
          </div>
        ))}
      </div>
    </div>
  );
}
