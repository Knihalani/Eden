/**
 * Wave 6.2 — settings integrations tabs: silent failures + misleading
 * "connected"/available states (webhooks DLQ, exports, retention, PII,
 * gateway, sidebar, status, integration banners).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import { interpretProbeFailure } from "@/hooks/use-integration-status";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6-2 settings integrations tabs", () => {
  it("probe failures never claim available on 5xx or network errors", () => {
    expect(interpretProbeFailure("gateway", new ApiError(503, "down")).available).toBe(
      false,
    );
    expect(interpretProbeFailure("gateway", new ApiError(500, "boom")).available).toBe(
      false,
    );
    expect(interpretProbeFailure("exports", new ApiError(403, "forbidden")).available).toBe(
      false,
    );
    expect(interpretProbeFailure("gateway", new ApiError(401, "auth")).available).toBe(
      true,
    );
    expect(interpretProbeFailure("stripe", new Error("network")).available).toBe(false);
    expect(
      interpretProbeFailure("gateway", new ApiError(500, "boom")).message,
    ).toMatch(/Could not verify|boom/i);
  });

  it("useIntegrationStatus outer catch marks unavailable (not available)", () => {
    const src = read("hooks/use-integration-status.ts");
    expect(src).toContain('setStatus("unavailable")');
    expect(src).toContain("Could not verify");
    // Must not fall through to available on unexpected throws.
    expect(src).not.toMatch(
      /catch\s*\{[^}]*setStatus\("available"\)/s,
    );
  });

  it("IntegrationStatusBanner surfaces status load failures with retry", () => {
    const src = read("components/settings/integration-status-banner.tsx");
    expect(src).toContain('kind: "error"');
    expect(src).toContain("Could not verify integration status");
    expect(src).toContain("Retry");
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*if\s*\(!cancelled\)\s*setMessages\(\[\]\)/);
  });

  it("retention and PII load failures use ErrorState + retry", () => {
    const retention = read(
      "app/(portal)/settings/_components/retention-policy-tab.tsx",
    );
    expect(retention).toContain('from "@/components/ui/error-state"');
    expect(retention).toContain('title="Could not load retention policy"');
    expect(retention).toContain("Try again");
    expect(retention).not.toContain("No retention policy available.");

    const pii = read("app/(portal)/settings/_components/pii-policy-tab.tsx");
    expect(pii).toContain('from "@/components/ui/error-state"');
    expect(pii).toContain('title="Could not load PII policy"');
    expect(pii).toContain("Try again");
    expect(pii).not.toContain("No PII policy available.");
  });

  it("exports gates empty tables behind !error", () => {
    const src = read("app/(portal)/settings/_components/exports-tab.tsx");
    expect(src).toContain("{!error && <section>");
    expect(src).toContain('title="Could not load exports"');
    expect(src).toContain("Try again");
  });

  it("sidebar save failures are surfaced (not silent auto-save)", () => {
    const hook = read("hooks/use-sidebar-prefs.ts");
    expect(hook).toContain("saveError");
    expect(hook).toContain("retrySave");
    expect(hook).not.toMatch(
      /catch\s*\{\s*\/\/ tolerate — sessionStorage still has the latest\.\s*\}/,
    );

    const view = read(
      "app/(portal)/settings/_components/sidebar-settings-view.tsx",
    );
    expect(view).toContain("Could not save sidebar preferences");
    expect(view).toContain("Retry save");
    expect(view).toContain("saveError");
  });

  it("status tab does not toast success when synthetics failed", () => {
    const src = read("app/(portal)/settings/_components/status-tab.tsx");
    expect(src).toContain("res.failed > 0");
    expect(src).toContain("toast.error");
    expect(src).toContain("Synthetics finished with failures");
    expect(src).not.toContain(
      "toast.success(`Synthetics complete (${res.failed} failed)`)",
    );
  });

  it("webhooks DLQ keeps QueryState error + empty honesty", () => {
    const src = read("app/(portal)/settings/(tabs)/webhooks-dlq/page.tsx");
    expect(src).toContain('errorTitle="Could not load DLQ entries"');
    expect(src).toContain("DLQ is clear");
    expect(src).toContain("toast.error");
    expect(src).toContain("Replay failed");
  });

  it("gateway tab keeps IntegrationStatusBanners + ErrorState", () => {
    const src = read("app/(portal)/settings/_components/gateway-tab.tsx");
    expect(src).toContain('integration="gateway"');
    expect(src).toContain('title="Could not load gateway models"');
  });
});
