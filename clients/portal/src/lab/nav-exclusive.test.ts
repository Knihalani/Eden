import { describe, expect, it } from "vitest";
import { PRIMARY_NAV, isExclusiveNavActive, isNavActive } from "@/lab/nav";

const hrefs = PRIMARY_NAV.map((i) => i.href);

describe("nav exclusive active (R008/R009)", () => {
  it("maps each product leaf to its own href", () => {
    const byId = Object.fromEntries(PRIMARY_NAV.map((i) => [i.id, i.href]));
    expect(byId.evals).toBe("/evals");
    expect(byId.signals).toBe("/signals");
    expect(byId.prompts).toBe("/prompts");
    expect(byId.issues).toBe("/issues");
    expect(byId.home).toBe("/home");
    expect(byId.traces).toBe("/traces");
    expect(byId.settings).toBe("/settings");
  });

  it("lights only one leaf on nested settings", () => {
    const actives = PRIMARY_NAV.filter((i) =>
      isExclusiveNavActive("/settings/roles", i.href, hrefs),
    ).map((i) => i.id);
    expect(actives).toEqual(["settings"]);
  });

  it("does not mark Home active on /settings/pii", () => {
    expect(isNavActive("/settings/pii", "/home")).toBe(false);
    expect(isExclusiveNavActive("/settings/pii", "/home", hrefs)).toBe(false);
    expect(isExclusiveNavActive("/settings/pii", "/settings", hrefs)).toBe(true);
  });

  it("does not mark Evals active on /signals", () => {
    expect(isNavActive("/signals", "/evals")).toBe(false);
    expect(isExclusiveNavActive("/signals", "/signals", hrefs)).toBe(true);
  });
});
