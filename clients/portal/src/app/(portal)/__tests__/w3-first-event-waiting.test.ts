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
    const src = read("app/(portal)/traces/page.tsx");
    expect(src).toContain("WaitingForFirstEvent");
    expect(src).toContain("onboardingV2Api");
    expect(src).toContain("first_trace_at");
    expect(src).toContain("refetchInterval");
    expect(src).not.toContain('title="No traces yet"');
  });

  it("dashboard first-run shows waiting title, doctor chips, and check CTA", () => {
    const src = read("app/(portal)/dashboard/page.tsx");
    expect(src).toContain("FIRST_EVENT_WAIT.title");
    expect(src).toContain("dashboard-doctor-commands");
    expect(src).toContain("DoctorCommandChip");
    expect(src).toContain("FIRST_EVENT_WAIT.checkCta");
    expect(src).toContain("first_trace_at");
    expect(src).toContain("refetchInterval");
  });
});
