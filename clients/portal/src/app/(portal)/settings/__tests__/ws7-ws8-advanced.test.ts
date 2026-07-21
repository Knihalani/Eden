/**
 * Wave 7–8 advanced surface markers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");
function read(rel: string) {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS7 advanced data plane", () => {
  it("gateway/pii/retention/exports/dlq markers", () => {
    expect(read("app/(portal)/settings/_components/gateway-tab.tsx")).toContain("data-ws7-gateway");
    expect(read("app/(portal)/settings/_components/gateway-tab.tsx")).toContain(
      "WS7_ADVANCED_DATA_COMPLETED",
    );
    expect(read("app/(portal)/settings/_components/pii-policy-tab.tsx")).toContain("data-ws7-pii");
    expect(read("app/(portal)/settings/_components/retention-policy-tab.tsx")).toContain(
      "data-ws7-retention",
    );
    expect(read("app/(portal)/settings/_components/exports-tab.tsx")).toContain("data-ws7-exports");
    expect(read("app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx")).toMatch(
      /data-ws7-dlq/,
    );
  });
});

describe("WS8 advanced ops + dedupe", () => {
  it("ops markers + legacy settings re-exports", () => {
    expect(read("app/(portal)/settings/_components/scim-tab.tsx")).toContain(
      "WS8_ADVANCED_OPS_COMPLETED",
    );
    expect(read("app/(portal)/settings/_components/mcp-tab.tsx")).toContain("data-ws8-mcp");
    expect(read("app/(portal)/settings/_components/org-settings.tsx")).toMatch(
      /export \{ OrgTab as OrgSettings/,
    );
    expect(read("app/(portal)/settings/_components/members-settings.tsx")).toMatch(
      /export \{ MembersTab as MembersSettings/,
    );
    expect(read("app/(portal)/settings/_components/api-keys-settings.tsx")).toMatch(
      /export \{ ApiKeysTab as ApiKeysSettings/,
    );
  });
});
