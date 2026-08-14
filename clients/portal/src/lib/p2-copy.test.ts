import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";

const src = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "src", ...parts), "utf8");

describe("P2 customer-facing copy (R055–R062, R057, R073)", () => {
  it("does not leak ticket codes or internals in Improve / Assistant / SSO / Topics / Audit / Gateway", () => {
    const files = [
      "components/improve/nudges-promotions-panel.tsx",
      "components/improve/canary-cockpit.tsx",
      "app/(portal)/agent/page.tsx",
      "app/(portal)/settings/sso/page.tsx",
      "app/(portal)/settings/scim/page.tsx",
      "app/(portal)/topics/page.tsx",
      "lab/settings/audit-chain-trust-signal.tsx",
      "app/(portal)/gateway/gateway-client.tsx",
    ];
    const joined = files.map((f) => src(...f.split("/"))).join("\n");
    // Ignore comment-only leftovers by checking JSX/string literals roughly:
    expect(joined).not.toMatch(/F39 runtime nudges/);
    expect(joined).not.toMatch(/gate \(W25\)/);
    expect(joined).not.toMatch(/Product assistant · t3/);
    expect(joined).not.toMatch(/<code>sso\.py<\/code>/);
    expect(joined).not.toMatch(/HDBSCAN clusterer/);
    expect(joined).not.toMatch(/chain: no rows/i);
    expect(joined).not.toMatch(/Add via gateway models API/);
  });

  it("Detectors copy says P0 not PO (R057)", () => {
    const text = src("app", "(portal)", "signals", "nl-alert-rules-panel.tsx");
    expect(text).toMatch(/not P0 security/);
    expect(text).not.toMatch(/not PO security/);
  });

  it("PII Fail closed is a checkbox, not a mode button (R066)", () => {
    const text = src("app", "(portal)", "settings", "pii", "page.tsx");
    expect(text).toMatch(/Fail closed on credential detection/);
    expect(text).not.toMatch(/id: "fail_closed"/);
  });

  it("group loading is chrome-only, not a 4-KPI grid (R073)", () => {
    const text = src("app", "(portal)", "loading.tsx");
    expect(text).toMatch(/RouteLoading/);
    expect(text).not.toMatch(/lg:grid-cols-4/);
    expect(text).toContain("RouteLoading");
  });
});
