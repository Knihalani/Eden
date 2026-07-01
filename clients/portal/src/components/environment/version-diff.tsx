"use client";

import { useMemo } from "react";

import { ArrowLeftRight, Plus, Minus } from "lucide-react";

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

function diffLines(oldCode: string, newCode: string): DiffLine[] {
  const oldLines = oldCode.split("\n");
  const newLines = newCode.split("\n");
  const result: DiffLine[] = [];

  // Simple line-by-line diff using LCS-like approach
  const lcs = longestCommonSubsequence(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const common of lcs) {
    // Emit removed lines (in old but not in common)
    while (oldIdx < common.oldIdx) {
      result.push({
        type: "removed",
        content: oldLines[oldIdx],
        oldLineNum: oldLineNum });
      oldIdx++;
      oldLineNum++;
    }

    // Emit added lines (in new but not in common)
    while (newIdx < common.newIdx) {
      result.push({
        type: "added",
        content: newLines[newIdx],
        newLineNum: newLineNum });
      newIdx++;
      newLineNum++;
    }

    // Emit common line
    result.push({
      type: "unchanged",
      content: common.line,
      oldLineNum: oldLineNum,
      newLineNum: newLineNum });
    oldIdx++;
    newIdx++;
    oldLineNum++;
    newLineNum++;
  }

  // Remaining removed lines
  while (oldIdx < oldLines.length) {
    result.push({
      type: "removed",
      content: oldLines[oldIdx],
      oldLineNum: oldLineNum });
    oldIdx++;
    oldLineNum++;
  }

  // Remaining added lines
  while (newIdx < newLines.length) {
    result.push({
      type: "added",
      content: newLines[newIdx],
      newLineNum: newLineNum });
    newIdx++;
    newLineNum++;
  }

  return result;
}

function longestCommonSubsequence(
  oldLines: string[],
  newLines: string[]
): Array<{ oldIdx: number; newIdx: number; line: string }> {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: Array<{ oldIdx: number; newIdx: number; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift({ oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

interface VersionDiffProps {
  oldVersion: { iteration: number; code: string; timestamp: string };
  newVersion: { iteration: number; code: string; timestamp: string };
}

export function VersionDiff({ oldVersion, newVersion }: VersionDiffProps) {
  const diff = useMemo(
    () => diffLines(oldVersion.code, newVersion.code),
    [oldVersion.code, newVersion.code]
  );

  const addedCount = diff.filter((l) => l.type === "added").length;
  const removedCount = diff.filter((l) => l.type === "removed").length;

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-[var(--text-muted)]" />
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Comparing v{oldVersion.iteration} → v{newVersion.iteration}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-[var(--terminal)]">
            <Plus className="w-3 h-3" /> {addedCount}
          </span>
          <span className="flex items-center gap-1 text-[var(--error)]">
            <Minus className="w-3 h-3" /> {removedCount}
          </span>
        </div>
      </div>

      {/* Diff view */}
      <div className="overflow-auto max-h-96 bg-[var(--code-surface)]">
        <table className="w-full text-sm font-mono">
          <tbody>
            {diff.map((line, idx) => (
              <tr
                key={idx}
                className={
                  line.type === "added"
                    ? "bg-[var(--terminal)]/20"
                    : line.type === "removed"
                    ? "bg-[var(--error)]/20"
                    : ""
                }
              >
                {/* Old line number */}
                <td className="px-3 py-0.5 text-[var(--text-secondary)] text-right select-none w-10 text-xs">
                  {line.oldLineNum || ""}
                </td>
                {/* New line number */}
                <td className="px-3 py-0.5 text-[var(--text-secondary)] text-right select-none w-10 text-xs">
                  {line.newLineNum || ""}
                </td>
                {/* Diff indicator */}
                <td className="px-2 py-0.5 text-center select-none w-4">
                  {line.type === "added" ? (
                    <span className="text-[var(--terminal)]">+</span>
                  ) : line.type === "removed" ? (
                    <span className="text-[var(--error)]">−</span>
                  ) : (
                    <span className="text-[var(--text-secondary)]"> </span>
                  )}
                </td>
                {/* Line content */}
                <td className="px-3 py-0.5 text-[var(--text-primary)] whitespace-pre">{line.content}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}