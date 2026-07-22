import { describe, expect, it } from "vitest";
import {
  buildDiagnosis,
  buildNextAction,
  deriveAgentStatus,
  mapFailureRows,
  pickWorstAgent,
  type AgentOsRow,
} from "@/lib/agent-health";

describe("deriveAgentStatus", () => {
  const now = Date.parse("2026-07-22T12:00:00.000Z");

  it("returns unknown when never seen and no traffic", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: null,
        errorRate: null,
        openIssueCount: 0,
        hasTrafficInWindow: false,
        nowMs: now,
      }),
    ).toBe("unknown");
  });

  it("returns silent when last seen >24h ago with no traffic", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: "2026-07-20T12:00:00.000Z",
        errorRate: 0,
        openIssueCount: 0,
        hasTrafficInWindow: false,
        nowMs: now,
      }),
    ).toBe("silent");
  });

  it("returns idle when recently seen but no window traffic", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: "2026-07-22T10:00:00.000Z",
        errorRate: 0,
        openIssueCount: 0,
        hasTrafficInWindow: false,
        nowMs: now,
      }),
    ).toBe("idle");
  });

  it("returns failing on high error rate", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: "2026-07-22T11:00:00.000Z",
        errorRate: 0.2,
        openIssueCount: 0,
        hasTrafficInWindow: true,
        nowMs: now,
      }),
    ).toBe("failing");
  });

  it("returns degraded on open issues", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: "2026-07-22T11:00:00.000Z",
        errorRate: 0,
        openIssueCount: 1,
        hasTrafficInWindow: true,
        nowMs: now,
      }),
    ).toBe("degraded");
  });

  it("returns healthy on traffic with low errors", () => {
    expect(
      deriveAgentStatus({
        lastSeenAt: "2026-07-22T11:00:00.000Z",
        errorRate: 0.001,
        openIssueCount: 0,
        hasTrafficInWindow: true,
        nowMs: now,
      }),
    ).toBe("healthy");
  });
});

describe("buildDiagnosis", () => {
  it("points connect when no agents", () => {
    const d = buildDiagnosis({
      openIssueCount: 0,
      errorTraceCount: 0,
      windowHours: 24,
      agentCount: 0,
      traceCountEver: 0,
    });
    expect(d.primaryHref).toBe("/agents/connect");
  });

  it("points issues when open issues exist", () => {
    const d = buildDiagnosis({
      openIssueCount: 2,
      errorTraceCount: 5,
      windowHours: 24,
      worstAgentId: "a1",
      worstAgentName: "Support",
      agentCount: 1,
      traceCountEver: 10,
    });
    expect(d.primaryHref).toContain("/issues");
    expect(d.primaryHref).toContain("agentId=a1");
    expect(d.worstAgentName).toBe("Support");
  });
});

describe("buildNextAction", () => {
  it("returns connect for first-run", () => {
    expect(
      buildNextAction({
        agentCount: 0,
        traceCountEver: 0,
        openIssueCount: 0,
        errorTraceCount: 0,
      }).kind,
    ).toBe("connect");
  });

  it("returns open_issue when issues present", () => {
    expect(
      buildNextAction({
        agentCount: 1,
        traceCountEver: 5,
        openIssueCount: 2,
        errorTraceCount: 1,
        worstAgentId: "x",
      }).kind,
    ).toBe("open_issue");
  });

  it("returns review_failures when errors and no issues", () => {
    expect(
      buildNextAction({
        agentCount: 1,
        traceCountEver: 5,
        openIssueCount: 0,
        errorTraceCount: 3,
      }).kind,
    ).toBe("review_failures");
  });

  it("returns healthy when quiet", () => {
    expect(
      buildNextAction({
        agentCount: 1,
        traceCountEver: 5,
        openIssueCount: 0,
        errorTraceCount: 0,
        worstStatus: "healthy",
      }).kind,
    ).toBe("healthy");
  });
});

describe("mapFailureRows", () => {
  it("maps error traces to failure rows", () => {
    const rows = mapFailureRows([
      {
        trace_id: "tr_1",
        agent_id: "a1",
        outcome: "error",
        duration_ms: 1200,
        input_tokens: 10,
        output_tokens: 20,
        cost_cents: 5,
        error: "timeout",
        started_at: "2026-07-22T11:00:00.000Z",
      },
      {
        trace_id: "tr_ok",
        outcome: "success",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.traceId).toBe("tr_1");
    expect(rows[0]?.summary).toBe("timeout");
    expect(rows[0]?.costUsd).toBe(0.05);
    expect(rows[0]?.totalTokens).toBe(30);
  });
});

describe("pickWorstAgent", () => {
  it("prefers failing over healthy", () => {
    const rows: AgentOsRow[] = [
      {
        agentId: "ok",
        displayName: "Ok",
        status: "healthy",
        errorRate: 0,
        costUsd: 1,
        lastSeenAt: null,
        openIssueCount: 0,
      },
      {
        agentId: "bad",
        displayName: "Bad",
        status: "failing",
        errorRate: 0.5,
        costUsd: 2,
        lastSeenAt: null,
        openIssueCount: 4,
      },
    ];
    expect(pickWorstAgent(rows)?.agentId).toBe("bad");
  });
});
