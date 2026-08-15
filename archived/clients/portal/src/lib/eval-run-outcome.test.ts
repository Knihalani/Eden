import { describe, expect, it } from "vitest";

import { interpretOfflineRunResult } from "./eval-run-outcome";

describe("interpretOfflineRunResult", () => {
  it("labels provider fallback runs without calling them heuristic stubs", () => {
    expect(
      interpretOfflineRunResult({
        status: "completed",
        synthetic: true,
        method: "offline_fallback",
      }),
    ).toEqual({
      kind: "completed",
      synthetic: true,
      message: "Offline fallback run finished — not a live model eval",
    });
  });

  it("calls legacy heuristic runs out explicitly", () => {
    expect(
      interpretOfflineRunResult({
        status: "completed",
        synthetic: true,
        method: "heuristic_stub",
      }).message,
    ).toBe("Legacy heuristic run finished — not a live model eval");
  });

  it("uses generic synthetic wording for other synthetic runs", () => {
    expect(
      interpretOfflineRunResult({
        status: "completed",
        synthetic: true,
        method: "synthetic_fixture",
      }).message,
    ).toBe("Synthetic run finished — not a live model eval");
  });

  it("does not treat an unknown status as a successful run", () => {
    expect(interpretOfflineRunResult({ status: "queued" })).toEqual({
      kind: "invalid",
      synthetic: false,
      message: "Unexpected run status: queued",
    });
  });
});
