/**
 * W3 — First-trace waiting UX (lightweight).
 * Empty traces / dashboard first-run: Waiting for first event + doctor + check CTA.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_EVENT_WAIT, U20_EMPTY_COPY } from "@/lib/portal-polish";

const portalSrc = resolve(__dirname, "../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W3 first-trace waiting UX", () => {
  it("exports calm waiting copy and doctor commands", () => {
    expect(FIRST_EVENT_WAIT.title).toBe("Waiting for first event");
    expect(FIRST_EVENT_WAIT.checkCta).toBe("Check for events");
    expect(FIRST_EVENT_WAIT.doctorNpx).toBe("npx eden-doctor");
    expect(FIRST_EVENT_WAIT.doctorPython).toBe("python -m eden_sdk.doctor");
    expect(FIRST_EVENT_WAIT.description).not.toMatch(/!/);
    expect(U20_EMPTY_COPY.traces).toContain("doctor");
  });

  it("traces empty uses WaitingForFirstEvent + first_trace_at signal", () => {
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    const hook = read("app/(portal)/traces/_components/use-traces-hub.ts");
    expect(list).toContain("WaitingForFirstEvent");
    expect(hook).toContain("onboardingV2Api");
    expect(hook).toContain("first_trace_at");
    expect(hook).toContain("refetchInterval");
    expect(list).not.toContain('title="No traces yet"');
  });

  it("dashboard first-run shows waiting title, doctor chips, and check CTA", () => {
    const page = read("app/(portal)/dashboard/page.tsx");
    const firstRun = read(
      "app/(portal)/dashboard/_components/home-first-run.tsx",
    );
    const hook = read(
      "app/(portal)/dashboard/_components/use-home-dashboard.ts",
    );
    expect(page).toContain("HomeFirstRun");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.title");
    expect(firstRun).toContain("dashboard-doctor-commands");
    expect(firstRun).toContain("DoctorCommandChip");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.checkCta");
    expect(hook).toContain("first_trace_at");
    expect(hook).toContain("refetchInterval");
  });
});
