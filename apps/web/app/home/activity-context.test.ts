import { expect, test } from "bun:test";
import { EMPTY_ACTIVITY, EMPTY_FLEET } from "./activity";
import { asView } from "./activity-context";

test("asView keeps the fleet strip so Home can show measured agents", () => {
  const fleet = {
    agents: [{ id: "a1", dcPct: 40, parentRunId: "p1" }, { id: "a2", dcPct: null }],
    fleetDcPct: 40,
    sharedLine: "shared across 2 agents",
    region: "us-east-1",
  };
  const view = asView({ ...EMPTY_ACTIVITY, fleet }, true);
  expect(view.ready).toBe(true);
  expect(view.fleet).toEqual(fleet);
  expect(asView(EMPTY_ACTIVITY, false).fleet).toEqual(EMPTY_FLEET);
});

test("asView drops a missing fleet onto honest empty, not a fake share", () => {
  const { fleet, ...without } = EMPTY_ACTIVITY;
  expect(fleet).toEqual(EMPTY_FLEET);
  const view = asView(without, true);
  expect(view.fleet).toEqual(EMPTY_FLEET);
  expect(view.dcPct).toBeNull();
});
