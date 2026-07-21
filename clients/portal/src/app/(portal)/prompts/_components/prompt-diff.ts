/**
 * Prompt template diff helpers — extracted from prompts/page.tsx (Wave 9.6).
 */

export type DiffLineType = "added" | "removed" | "unchanged";

export function summarizeTemplateDiff(oldText: string, newText: string) {
  const lines = buildTemplateDiff(oldText, newText);
  return {
    added: lines.filter((l) => l.type === "added").length,
    removed: lines.filter((l) => l.type === "removed").length,
  };
}

export function buildTemplateDiff(
  oldText: string,
  newText: string,
): Array<{ type: DiffLineType; content: string }> {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lcs = longestCommonSubsequence(oldLines, newLines);
  const out: Array<{ type: DiffLineType; content: string }> = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const common of lcs) {
    while (oldIdx < common.oldIdx) {
      out.push({ type: "removed", content: oldLines[oldIdx]! });
      oldIdx++;
    }
    while (newIdx < common.newIdx) {
      out.push({ type: "added", content: newLines[newIdx]! });
      newIdx++;
    }
    out.push({ type: "unchanged", content: common.line });
    oldIdx++;
    newIdx++;
  }
  while (oldIdx < oldLines.length) {
    out.push({ type: "removed", content: oldLines[oldIdx]! });
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    out.push({ type: "added", content: newLines[newIdx]! });
    newIdx++;
  }
  return out;
}

function longestCommonSubsequence(
  oldLines: string[],
  newLines: string[],
): Array<{ oldIdx: number; newIdx: number; line: string }> {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const lcs: Array<{ oldIdx: number; newIdx: number; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      lcs.unshift({ oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1]! });
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return lcs;
}
