// @vitest-environment node
/**
 * W15-a portal long-tail — P6b / P2-phase2 / P11 / P15 Done-when checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("W15-a portal long-tail Done-when", () => {
  it("P2-phase2: RSC portal layout + PortalProviders off root", () => {
    const layout = read("app/(portal)/layout.tsx");
    expect(layout).not.toMatch(/^["']use client["']/m);
    expect(layout).toMatch(/PortalProviders/);
    expect(layout).toMatch(/PortalChrome/);
    expect(read("app/(portal)/portal-chrome.tsx")).toMatch(/^["']use client["']/m);
    expect(read("app/layout.tsx")).not.toMatch(/PortalProviders/);
  });

  it("P6b: migrated batch uses useOrgQuery", () => {
    const files = [
      "app/(portal)/labeling/page.tsx",
      "app/(portal)/insights/topics/page.tsx",
      "app/(portal)/playgrounds/page.tsx",
      "app/(portal)/observability/query/page.tsx",
      "app/(portal)/observability/memory/page.tsx",
      "app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx",
      "app/(portal)/settings/_components/pii-policy-tab.tsx",
      "app/(portal)/settings/_components/retention-policy-tab.tsx",
      "app/(portal)/settings/_components/analytics-tab.tsx",
      "app/(portal)/settings/_components/audit-log-tab.tsx",
      "app/(portal)/settings/_components/scim-tab.tsx",
      "app/(portal)/settings/_components/sso-tab.tsx",
      "app/(portal)/settings/_components/references-tab.tsx",
      "app/(portal)/settings/_components/roles-tab.tsx",
      "app/(portal)/settings/_components/finops-kills-tab.tsx",
      "app/(portal)/settings/_components/security-tab.tsx",
    ];
    for (const f of files) {
      expect(read(f), f).toMatch(/useOrgQuery/);
    }
  });

  it("P15: policy tabs skip save when not dirty", () => {
    const pii = read("app/(portal)/settings/_components/pii-policy-tab.tsx");
    const ret = read("app/(portal)/settings/_components/retention-policy-tab.tsx");
    expect(pii).toMatch(/const dirty = JSON\.stringify\(policy\) !== JSON\.stringify\(draft\)/);
    expect(pii).toMatch(/if \(!dirty\) return;/);
    // Retention uses `baseline` (saved DraftMap) vs `draft` after Wave 2 rewrite.
    expect(ret).toMatch(/const dirty = JSON\.stringify\(baseline\) !== JSON\.stringify\(draft\)/);
    expect(ret).toMatch(/if \(!dirty\) return;/);
  });

  it("P11: high-traffic portal pages drop AnimatePresence/framer-motion", () => {
    const files = [
      "app/(portal)/alerts/page.tsx",
      "app/(portal)/users/page.tsx",
      "app/(portal)/tools/page.tsx",
      "app/(portal)/studio/page.tsx",
      "app/(portal)/observability/eval/page.tsx",
      "app/(portal)/observability/retrieval/page.tsx",
      "app/(portal)/observability/memory/page.tsx",
      "app/(portal)/optimization/page.tsx",
      "app/(portal)/guardrails/page.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/framer-motion/);
      expect(src, f).not.toMatch(/AnimatePresence/);
    }
  });
});
