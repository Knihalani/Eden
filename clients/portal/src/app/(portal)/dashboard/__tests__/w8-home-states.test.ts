/**
 * Wave 8 — Home states: first-run ≠ empty ≠ error; loading skeleton;
 * QueryState grammar; perf + a11y markers.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");
const portalRoot = resolve(portalSrc, "..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 8 Home states", () => {
  const page = read("app/(portal)/dashboard/page.tsx");
  const firstRun = read(
    "app/(portal)/dashboard/_components/home-first-run.tsx",
  );
  const failures = read(
    "app/(portal)/dashboard/_components/recent-failures-card.tsx",
  );
  const loading = read("app/(portal)/dashboard/loading.tsx");
  const skeleton = read(
    "app/(portal)/dashboard/_components/home-dashboard-skeleton.tsx",
  );
  const kpi = read(
    "app/(portal)/dashboard/_components/home-kpi-strip.tsx",
  );
  const diagnosis = read(
    "app/(portal)/dashboard/_components/diagnosis-strip.tsx",
  );
  const note = readFileSync(
    resolve(portalRoot, ".home-shell-w8-states.md"),
    "utf8",
  );

  it("marks wave8 states + preserves W6/W7/W11", () => {
    expect(page).toContain("WAVE8_HOME_STATES = true");
    expect(page).toContain('data-wave8-home="states"');
    expect(page).toContain("WAVE6_HOME_COMPLETED = true");
    expect(page).toContain("WAVE7_HOME_COMPOSITION = true");
    expect(page).toContain("WAVE11_HOME_PROTECTED = true");
    expect(page).toContain('data-home-shell-home="status-diagnosis-action"');
  });

  it("first-run ≠ empty ≠ error (distinct markers + paths)", () => {
    expect(firstRun).toContain('data-home-shell-state="first-run"');
    expect(firstRun).toContain("data-home-shell-listening");
    expect(firstRun).toContain('data-home-shell-next-step="doctor"');
    expect(firstRun).not.toContain('data-query-state="empty"');
    expect(firstRun).not.toContain('data-query-state="error"');
    expect(firstRun).not.toContain("No failures in this window");

    expect(failures).toContain('data-home-shell-state="empty"');
    expect(failures).toContain("data-empty-kind");
    expect(failures).toContain("period-empty");
    expect(failures).toContain('data-query-state="error"');
    expect(failures).toContain("Failures unavailable");
    expect(failures).not.toContain("Waiting for first event");
    expect(failures).not.toContain("FIRST_EVENT_WAIT");

    expect(page).toContain('data-query-state="error"');
    expect(page).toContain('data-home-shell-state="no-org"');
    expect(page).toContain("ErrorState");
    expect(page).toContain("NoOrgState");

    // Mutually exclusive render: first-run branch vs ready composition.
    expect(page).toMatch(/d\.isFirstRun \?[\s\S]*HomeFirstRun[\s\S]*: \(/);
    expect(page).toContain("HomeKpiStrip");
  });

  it("HomeFirstRun is Laminar listening + one doctor next step", () => {
    expect(firstRun).toContain("Listening for first event");
    expect(firstRun).toContain("One next step");
    expect(firstRun).toContain("FIRST_EVENT_WAIT");
    expect(firstRun).toContain("DoctorCommandChip");
    expect(firstRun).toContain("dashboard-doctor-commands");
    expect(firstRun).toContain("FIRST_EVENT_WAIT.checkCta");
    expect(firstRun).toContain('role="region"');
    expect(firstRun).toContain("aria-labelledby");
  });

  it("loading skeleton matches W7 composition (shared component)", () => {
    expect(loading).toContain("HomeDashboardSkeleton");
    expect(skeleton).toContain('data-home-shell-state="loading"');
    expect(skeleton).toContain('data-home-shell-kpi="restraint"');
    expect(skeleton).toContain("xl:grid-cols-4");
    expect(skeleton).not.toContain("h-10 w-10 rounded-lg");
    expect(page).toContain("HomeDashboardSkeleton");
  });

  it("keeps usePagePerf and lazy islands for diagnosis/failures", () => {
    expect(page).toContain('usePagePerf("/dashboard")');
    expect(page).toContain('from "next/dynamic"');
    expect(page).toContain("DiagnosisStrip");
    expect(page).toContain("RecentFailuresCard");
    expect(page).toMatch(/dynamic\([\s\S]*diagnosis-strip/);
    expect(page).toMatch(/dynamic\([\s\S]*recent-failures-card/);
  });

  it("a11y landmarks on Home path regions", () => {
    expect(kpi).toContain('aria-label="Status metrics"');
    expect(kpi).toContain("<section");
    expect(diagnosis).toContain('role="region"');
    expect(diagnosis).toContain("home-diagnosis-title");
    expect(failures).toContain('role="region"');
    expect(failures).toContain("home-failures-title");
    expect(firstRun).toContain("home-first-run-title");
    expect(firstRun).toContain("focus-visible:ring");
  });

  it("ships wave note with state matrix + golden baseline path", () => {
    expect(note).toMatch(/Wave 8/i);
    expect(note).toMatch(/first-run/i);
    expect(note).toMatch(/empty/i);
    expect(note).toMatch(/error/i);
    expect(note).toMatch(/e2e\/golden/);
    expect(
      existsSync(
        resolve(portalRoot, "e2e/golden/screenshots/01-sign-in-home.png"),
      ) ||
        existsSync(
          resolve(
            portalRoot,
            "e2e/golden/screenshots/01-sign-in-home-fail.png",
          ),
        ),
    ).toBe(true);
  });
});
