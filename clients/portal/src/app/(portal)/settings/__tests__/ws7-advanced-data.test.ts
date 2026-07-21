/**
 * Wave 7 — Advanced data plane exit evidence (S13 / S14 / S23).
 * Source-level asserts: markers, kit Button, workspace copy, DLQ redirect-only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("WS7 Advanced data plane", () => {
  const gateway = read("app/(portal)/settings/_components/gateway-tab.tsx");
  const pii = read("app/(portal)/settings/_components/pii-policy-tab.tsx");
  const retention = read("app/(portal)/settings/_components/retention-policy-tab.tsx");
  const exportsTab = read("app/(portal)/settings/_components/exports-tab.tsx");
  const dlqTab = read("app/(portal)/settings/_components/webhooks-dlq-tab.tsx");
  const dlqPage = read("app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx");
  const registry = read("app/(portal)/settings/_components/settings-tab-registry.ts");

  it("exposes WS7_ADVANCED_DATA_COMPLETED in one file", () => {
    expect(gateway).toContain("WS7_ADVANCED_DATA_COMPLETED");
    expect(pii).not.toContain("WS7_ADVANCED_DATA_COMPLETED");
    expect(retention).not.toContain("WS7_ADVANCED_DATA_COMPLETED");
    expect(exportsTab).not.toContain("WS7_ADVANCED_DATA_COMPLETED");
  });

  it("marks gateway / pii / retention / exports / dlq with data-ws7-*", () => {
    expect(gateway).toContain("data-ws7-gateway");
    expect(pii).toContain("data-ws7-pii");
    expect(retention).toContain("data-ws7-retention");
    expect(exportsTab).toContain("data-ws7-exports");
    expect(dlqTab).toContain("data-ws7-dlq");
  });

  it("uses kit Button on advanced data tabs", () => {
    for (const src of [gateway, pii, retention, exportsTab, dlqTab]) {
      expect(src).toContain('from "@/components/ui/button"');
    }
  });

  it("uses workspace copy (not organization) on empty / permission gates", () => {
    expect(gateway).toContain("Select a workspace");
    expect(pii).toContain("Select a workspace");
    expect(retention).toContain("Select a workspace");
    expect(exportsTab).toContain("Select a workspace");
    expect(exportsTab).toContain("workspace admin");
    expect(dlqTab).toContain("workspace admin");
    expect(gateway).not.toContain("Select an organization");
    expect(pii).not.toContain("Select an organization");
    expect(retention).not.toContain("Select an organization");
  });

  it("registers webhooks-dlq under Advanced and keeps FS stub redirect-only", () => {
    expect(registry).toContain('id: "webhooks-dlq"');
    expect(registry).toContain('category: "Advanced"');
    expect(dlqPage).toContain('params.set("tab", "webhooks-dlq")');
    expect(dlqPage).toContain("router.replace");
    expect(dlqPage).toContain("data-ws7-dlq-redirect");
    expect(dlqPage).not.toContain("listWebhookDlq");
    expect(dlqPage).not.toContain("QueryState");
  });
});
