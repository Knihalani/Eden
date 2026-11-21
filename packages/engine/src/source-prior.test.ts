import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import type { Scope } from "@eden/protocol";
import { sourcePriors } from "./source-prior";

// `sourceKindPrior` (D2015, Q7(b)): the static per-connector-kind prior that reshapes a cold source's routing draw.

const scope: Scope = { tenantId: "t", userId: "u" };

describe("sourcePriors (D2015)", () => {
  test("the table's kinds get their mean; anything else gets the unknown prior", () => {
    const p = sourcePriors(
      [
        { id: "gmail", description: "the user's mail" },
        { id: "cal-work", description: "work calendar" },
        { id: "wiki-23", description: "A wiki the user is connected to" },
      ],
      20,
    )!;
    expect(p.get("gmail")).toEqual({ alpha: 15, beta: 5 });
    expect(p.get("cal-work")).toEqual({ alpha: 15, beta: 5 });
    expect(p.get("wiki-23")).toEqual({ alpha: 0, beta: 10 });
    expect(sourcePriors([{ id: "gmail", description: "x" }], 0)).toBeUndefined();
  });

  test("a cold route ranks the known kinds above every unknown source", () => {
    // 200 flat-draw unknowns and one mail: without the prior the mail lands wherever the draw puts it.
    const ids = ["gmail", ...Array.from({ length: 200 }, (_, i) => `noise-${i}`)];
    const map = new SourceMap(":memory:", { seed: 11 });
    const priors = sourcePriors(
      [{ id: "gmail", description: "the user's mail" }, ...ids.slice(1).map((id) => ({ id, description: id }))],
      20,
    );
    const top = (ps?: typeof priors) =>
      map.route({ scope, entities: [], situation: "s", sourceIds: ids, limit: 3, ...(ps ? { priors: ps } : {}) });
    const withPrior = top(priors).map((r) => r.sourceId);
    expect(withPrior[0]).toBe("gmail");
    // Off, nothing in the request favours the mail: it is not first for this seed.
    expect(top()[0]!.sourceId).not.toBe("gmail");
  });

  test("the prior yields to a source's own evidence", () => {
    const map = new SourceMap(":memory:", { seed: 7 });
    const ids = ["gmail", "noise-1"];
    const priors = sourcePriors(
      [
        { id: "gmail", description: "mail" },
        { id: "noise-1", description: "a source" },
      ],
      20,
    )!;
    // noise-1 used every time it was shown (a strong track record) draws ahead of the never-used mail.
    for (let i = 0; i < 12; i++) map.recordOutcome(scope, "chat", "noise-1", true);
    const r = map.route({ scope, entities: [], situation: "chat", sourceIds: ids, limit: 1, priors });
    expect(r[0]!.sourceId).toBe("noise-1");
  });
});
