import { describe, expect, it } from "vitest";

import {
  IMPROVE_FEATURE_DISABLED_MESSAGE,
  REPO_NOT_CONNECTED_MESSAGE,
  isImprovementAgentDisabled,
  isRepoNotConnected,
} from "@/lib/improve-feature";
import { toUserFacingError } from "@/lib/safe-error-message";

describe("toUserFacingError — improve honesty", () => {
  it("does not collapse improvement_agent_v1 503 into generic server banner", () => {
    const msg = toUserFacingError({
      status: 503,
      message: "improvement_agent_v1 is disabled for this org",
    });
    expect(msg).toBe(IMPROVE_FEATURE_DISABLED_MESSAGE);
    expect(msg).not.toMatch(/trouble reaching the server/i);
  });

  it("maps repo_not_connected 503 to connect-GitHub copy", () => {
    const msg = toUserFacingError({
      status: 503,
      message: JSON.stringify({
        status: "error",
        error: "repo_not_connected",
        message: "Connect GitHub App in Settings",
      }),
    });
    expect(msg).toBe(REPO_NOT_CONNECTED_MESSAGE);
  });

  it("still maps unrelated 503 to generic server banner", () => {
    const msg = toUserFacingError({
      status: 503,
      message: "Backend unavailable",
    });
    expect(msg).toMatch(/trouble reaching the server/i);
  });
});

describe("isImprovementAgentDisabled / isRepoNotConnected", () => {
  it("detects mapped and raw disabled messages", () => {
    expect(isImprovementAgentDisabled(new Error(IMPROVE_FEATURE_DISABLED_MESSAGE))).toBe(
      true,
    );
    expect(
      isImprovementAgentDisabled(new Error("improvement_agent_v1 is disabled for this org")),
    ).toBe(true);
    expect(
      isImprovementAgentDisabled(
        new Error("Ask an admin or Eden support to enable it — Settings does not turn this on."),
      ),
    ).toBe(true);
    expect(isImprovementAgentDisabled(new Error("Backend unavailable"))).toBe(false);
  });

  it("detects repo_not_connected", () => {
    expect(isRepoNotConnected(new Error(REPO_NOT_CONNECTED_MESSAGE))).toBe(true);
    expect(isRepoNotConnected('{"error":"repo_not_connected"}')).toBe(true);
    expect(isRepoNotConnected(new Error("Approve failed"))).toBe(false);
  });

  it("disabled copy does not claim Settings can enable the flag", () => {
    expect(IMPROVE_FEATURE_DISABLED_MESSAGE).toMatch(/Settings does not turn this on/i);
    expect(IMPROVE_FEATURE_DISABLED_MESSAGE).not.toMatch(/Open Settings/i);
  });
});
