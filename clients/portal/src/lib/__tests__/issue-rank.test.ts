import { describe, expect, it } from "vitest";
import {
  bucketIssueRankTier,
  rankTierForIssue,
  rankTierLabel,
} from "@/lib/issue-rank";

describe("issue-rank", () => {
  it("buckets scores relative to the loaded list", () => {
    const scores = [100, 80, 60, 40, 20, 10, 5, 2, 1, 0.5];
    expect(bucketIssueRankTier(100, scores)).toBe("top");
    expect(bucketIssueRankTier(80, scores)).toBe("high");
    expect(bucketIssueRankTier(40, scores)).toBe("high");
    expect(bucketIssueRankTier(20, scores)).toBe("medium");
    expect(bucketIssueRankTier(0.5, scores)).toBe("low");
  });

  it("labels tiers for display", () => {
    expect(rankTierLabel("top")).toBe("Top priority");
    expect(rankTierLabel("high")).toBe("High");
  });

  it("returns null when rank score is missing", () => {
    expect(rankTierForIssue({ rankScore: null }, [{ rankScore: 1 }])).toBeNull();
  });
});
