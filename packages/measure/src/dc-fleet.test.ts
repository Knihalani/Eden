import { describe, expect, test } from "bun:test";
import { emptyTokenClasses } from "@eden/ir";
import { dcShare } from "./dc";
import { aggregateDc } from "./dc-day";
import { aggregateFleetDc, type FleetDcRun } from "./dc-fleet";

describe("aggregateFleetDc", () => {
  test("empty is 0, not a fake share", () => {
    const row = aggregateFleetDc([]);
    expect(row.dcShare).toBe(0);
    expect(row.dcPct).toBe(0);
    expect(row.classes).toEqual(emptyTokenClasses());
  });

  test("uses frozen dcShare and ignores providerCache", () => {
    const runs: FleetDcRun[] = [
      {
        fleet: "f1",
        agent: "intake",
        region: "us-east-1",
        classes: { compiled: 4, memoized: 0, transparent: 0, steeredSkip: 2, frontier: 4, providerCache: 9_000 },
      },
      {
        fleet: "f1",
        agent: "billing",
        region: "us-east-1",
        classes: { compiled: 1, memoized: 1, transparent: 0, steeredSkip: 0, frontier: 2 },
      },
    ];
    const row = aggregateFleetDc(runs);
    expect(row.fleet).toBe("f1");
    expect(row.region).toBe("us-east-1");
    expect(row.classes.compiled).toBe(5);
    expect(row.classes.steeredSkip).toBe(2);
    expect(row.classes.frontier).toBe(6);
    expect(row.classes.providerCache).toBe(9_000);
    expect(row.dcShare).toBe(dcShare(row.classes));
    expect(row.dcShare).toBe(8 / 14);
    expect(row.dcPct).toBe((8 / 14) * 100);
  });

  test("independent of workspace×day aggregateDc", () => {
    const classes = { compiled: 3, memoized: 0, transparent: 0, steeredSkip: 1, frontier: 1 };
    const fleet = aggregateFleetDc([{ fleet: "f", classes }]);
    const days = aggregateDc([{ workspace: "ws", day: "2026-08-20", classes }]);
    expect(fleet.dcShare).toBe(days[0]!.dcShare);
    expect(fleet.dcPct).toBe(days[0]!.dcPct);
    expect("workspace" in fleet).toBe(false);
    expect("day" in fleet).toBe(false);
  });
});
