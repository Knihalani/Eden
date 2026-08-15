import { describe, expect, it } from "vitest";

import { issuesSnapshot, type IssueFixture } from "./issues";

const baseIssue: IssueFixture = {
  id: "issue-open",
  title: "Open issue",
  summary: "Open",
  body: "Open issue body",
  severity: "error",
  status: "open",
  agentId: "agent-1",
  fingerprint: "fp-open",
  detector: "detector",
  environment: "production",
  occurrenceTraceIds: ["trace-1"],
  firstSeen: "2026-08-01T00:00:00Z",
  lastSeen: "2026-08-01T00:00:00Z",
  signalCount: 1,
  errorSample: "error",
  impact: "impact",
  suggestedFix: "fix",
  tags: [],
};

describe("issue fixture read model", () => {
  it("keeps ignored issues out of active severity counts", () => {
    const ignored: IssueFixture = {
      ...baseIssue,
      id: "issue-ignored",
      status: "ignored",
      occurrenceTraceIds: ["trace-ignored"],
    };

    const snapshot = issuesSnapshot([baseIssue, ignored]);

    expect(snapshot.errors).toEqual([baseIssue]);
    expect(snapshot.activeCount).toBe(1);
    expect(snapshot.resolved).toEqual([]);
  });
});
