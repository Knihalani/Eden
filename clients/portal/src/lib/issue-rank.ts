/** Composite issue rank tiers — client-side bucketing (FEAT-159). */

export type IssueRankTier = "top" | "high" | "medium" | "low";

export type IssueRankInput = {
  rankScore?: number | null;
};

export function bucketIssueRankTier(
  score: number,
  allScores: number[],
): IssueRankTier {
  if (!Number.isFinite(score) || allScores.length === 0) return "low";
  const sorted = [...allScores].filter(Number.isFinite).sort((a, b) => b - a);
  if (sorted.length === 0) return "low";
  const idx = sorted.findIndex((s) => s <= score);
  const rankIndex = idx === -1 ? sorted.length - 1 : idx;
  const pct = rankIndex / Math.max(sorted.length - 1, 1);
  if (pct <= 0.1) return "top";
  if (pct <= 0.35) return "high";
  if (pct <= 0.7) return "medium";
  return "low";
}

export function rankTierLabel(tier: IssueRankTier): string {
  if (tier === "top") return "Top priority";
  if (tier === "high") return "High";
  if (tier === "medium") return "Medium";
  return "Low";
}

export function rankTierForIssue(
  issue: IssueRankInput,
  allIssues: IssueRankInput[],
): IssueRankTier | null {
  const score = issue.rankScore;
  if (score == null || !Number.isFinite(score)) return null;
  const scores = allIssues
    .map((i) => i.rankScore)
    .filter((s): s is number => s != null && Number.isFinite(s));
  if (scores.length === 0) return null;
  return bucketIssueRankTier(score, scores);
}
