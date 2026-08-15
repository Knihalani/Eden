import { describe, expect, it } from "vitest";

import { experimentFixtureFromApi } from "./evals";

describe("experimentFixtureFromApi", () => {
  it("passes through grades and honesty flags from run result", () => {
    const fixture = experimentFixtureFromApi(
      { id: "exp-1", name: "Run 1", dataset_id: "ds-1" },
      {
        result: {
          grades: { exact_match: 0.8 },
          synthetic: true,
          method: "offline_fallback",
        },
      },
    );

    expect(fixture.avgScores).toEqual({ exact_match: 0.8 });
    expect(fixture.synthetic).toBe(true);
    expect(fixture.method).toBe("offline_fallback");
  });

  it("defaults heuristic honesty for promote stubs", () => {
    const fixture = experimentFixtureFromApi(
      { id: "exp-2", name: "Promoted", dataset_id: "ds-1" },
      { heuristicStub: true },
    );

    expect(fixture.synthetic).toBe(true);
    expect(fixture.method).toBe("heuristic_stub");
  });

  it("prefers API result grades over empty experiment payload", () => {
    const fixture = experimentFixtureFromApi(
      { id: "exp-3", dataset_id: "ds-1", avgScores: { score: 0.1 } },
      {
        result: { grades: { score: 0.9 } },
        overrides: { playgroundId: "pg-1" },
      },
    );

    expect(fixture.avgScores).toEqual({ score: 0.9 });
    expect(fixture.playgroundId).toBe("pg-1");
  });
});
