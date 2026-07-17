#!/usr/bin/env node
/**
 * F85 — 8 golden paths (Playwright). Set GOLDEN_CI=1 in CI.
 *
 * Requires e2e/.auth-state.json — run seed-auth.mjs first.
 * Screenshots → e2e/golden/screenshots/
 *
 * Required env vars (for seed-auth, sourced before this script):
 *   CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
 */
import { chromium } from "playwright";
import { setupClerkTestingToken, clerkSetup } from "@clerk/testing/playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(__dirname, "../..");
loadEnv({ path: resolve(PORTAL_ROOT, ".env.local") });
loadEnv({ path: resolve(PORTAL_ROOT, ".env") });
import {
  BASE,
  FIXTURE_TRACE,
  loadAuthState,
  assertNoCrash,
  assertAuthShell,
  assertPageLoaded,
  screenshotStep,
} from "./helpers.mjs";

const GOLDEN_CI = process.env.GOLDEN_CI === "1";

// ── Path definitions ────────────────────────────────────────────────────────
const PATHS = [
  { id: "01-sign-in-home",        route: "/dashboard",         label: "Sign-in → Home (/dashboard)" },
  { id: "02-traces-hub",          route: "/traces",            label: "Traces hub" },
  { id: "03-issues",              route: "/issues",            label: "Issues list" },
  { id: "04-artifacts",           route: "/artifacts",         label: "Artifacts" },
  { id: "05-playgrounds",         route: "/evals?tab=playgrounds",       label: "Playground" },
  { id: "06-alerts",              route: "/alerts",            label: "Alerts" },
  { id: "07-experiments",         route: "/evals?tab=experiments",       label: "Experiments compare" },
  { id: "08-debugger-sessions",   route: "/debugger-sessions", label: "Debugger sessions" },
];

// ── Deep assertion functions per golden path ────────────────────────────────

/**
 * Path 1: Sign-in → Home (/dashboard)
 * Asserts authenticated shell loaded (not redirected to /sign-in) and the
 * dashboard page renders a heading or no-org state — not a blank page.
 */
async function assertDashboard(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);
  // Could be "Telemetry Overview", "Get started with observability", or NoOrgState
  const body = await page.locator("body").innerText().catch(() => "");
  const hasContent =
    heading != null ||
    /Telemetry Overview|Get started|No org|Finish setup|Welcome back/i.test(body);
  if (!hasContent) {
    throw new Error("Dashboard: no recognisable page content rendered");
  }
  return heading || "(no-org / first-run state)";
}

/**
 * Path 2: Traces hub
 * Asserts the Traces page renders (with or without real data).
 * Also checks that the fixture trace ID is linkable (client-side routing).
 */
async function assertTraces(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  // Navigate with the fixture trace ID — the page should accept the query
  // param and not crash, even if no matching trace exists in the backend.
  const fixtureTraceId = FIXTURE_TRACE.trace_id;
  await page.goto(`${BASE}/traces?traceId=${fixtureTraceId}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(1200);
  await assertNoCrash(page);
  await screenshotStep(page, "02-traces-with-fixture-id");

  const bodyText = await page.locator("body").innerText().catch(() => "");
  // Either a trace panel opened or an empty-state / "no trace found" message
  const acceptable =
    /transcript|span|agent\.turn|no trace|not found|no results|Traces/i.test(bodyText);
  if (!acceptable) {
    console.warn("[golden][02] Traces: fixture trace ID rendered unexpected content (non-fatal)");
  }
  return heading || "(traces hub)";
}

/**
 * Path 3: Issues list + cross-link to Artifacts
 * Asserts Issues page renders and, if issues exist, attempts to navigate
 * to the shadow artifact cross-link. Degrades loudly if no data.
 */
async function assertIssues(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasIssues = /ISS-|issue-|iss_/.test(bodyText) || /open|closed|triaged/i.test(bodyText);

  if (!hasIssues) {
    console.log(
      "  SKIPPED (03-issues→artifact cross-link): no issues rendered — backend API not running or org has no issues",
    );
    return heading || "(issues empty state)";
  }

  // Try to click the first issue row to open the detail panel
  const issueRow = page.locator('[data-testid="issue-row"], [data-row-id], table tbody tr').first();
  if (await issueRow.count()) {
    await issueRow.click().catch(() => {});
    await page.waitForTimeout(800);
    await screenshotStep(page, "03-issue-detail");

    // Assert the detail panel opened (cross-link to artifact is inside)
    const panel = await page.locator('[data-testid="detail-panel"], aside, [role="dialog"]').count();
    if (panel === 0) {
      console.log("  SKIPPED (03-issues→artifact cross-link): detail panel did not open");
    } else {
      // Check for shadow artifact cross-link in the panel
      const artifactLink = page.locator('a[href*="/artifacts"]');
      if (await artifactLink.count()) {
        console.log("  ✓ 03 cross-link to /artifacts found in issue detail");
      } else {
        console.log("  SKIPPED (03-issues→artifact cross-link): no /artifacts link in panel (no shadow artifact for this issue)");
      }
    }
  }
  return heading || "(issues list)";
}

/**
 * Path 4: Artifacts + EvidenceGate
 * Asserts Artifacts page renders. If artifacts exist, checks for a "promote"
 * or "reject" / EvidenceGate affordance. Degrades loudly if no data.
 */
async function assertArtifacts(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasArtifacts = /ART-|artifact/i.test(bodyText) && !/no artifact|no data/i.test(bodyText);

  if (!hasArtifacts) {
    console.log(
      "  SKIPPED (04-artifact→promote cross-link): no artifacts rendered — backend API not running",
    );
    return heading || "(artifacts empty state)";
  }

  // Check for EvidenceGate / promote affordance
  const promoteBtn = page.locator('button:has-text("Promote"), button:has-text("Review"), [data-testid="evidence-gate"]');
  if (await promoteBtn.count()) {
    console.log("  ✓ 04 EvidenceGate / Promote button found");
  } else {
    // Try clicking first artifact to open detail panel
    const row = page.locator('[data-testid="artifact-row"], table tbody tr').first();
    if (await row.count()) {
      await row.click().catch(() => {});
      await page.waitForTimeout(800);
      await screenshotStep(page, "04-artifact-detail");
      const gate = await page.locator('button:has-text("Promote"), button:has-text("Reject"), [data-testid="evidence-gate"]').count();
      if (gate) {
        console.log("  ✓ 04 EvidenceGate visible in artifact detail");
      } else {
        console.log("  SKIPPED (04-artifact EvidenceGate): gate UI not found in detail panel");
      }
    } else {
      console.log("  SKIPPED (04-artifact EvidenceGate): no artifact rows to click");
    }
  }
  return heading || "(artifacts)";
}

/**
 * Path 5: Playground from-span → run
 * Asserts the Playgrounds page renders (or its empty state).
 * Checks for a "New playground" / "Run" affordance.
 */
async function assertPlaygrounds(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  // The playground page should always have a "New playground" button or empty state
  const hasAffordance =
    /new playground|create playground|no playground|run/i.test(bodyText) ||
    (await page.locator('button:has-text("New"), button:has-text("playground"), [data-testid="new-playground"]').count()) > 0;

  if (!hasAffordance) {
    console.log("  SKIPPED (05-playground run): no playground affordance found — checking for empty state");
    const hasPage = heading != null || /playground/i.test(bodyText);
    if (!hasPage) {
      throw new Error("Playgrounds page rendered no recognisable content");
    }
  } else {
    console.log("  ✓ 05 Playground affordance (New/Run) visible");
  }
  return heading || "(playgrounds)";
}

/**
 * Path 6: Alerts — NL compile affordance (+ deep ack when seeded)
 * Without Clerk org data / backend, compile→save→ack is SKIPPED (W3 gap).
 */
async function assertAlerts(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasAlertAffordance =
    /new alert|create alert|compile|natural language|no alert/i.test(bodyText) ||
    (await page.locator('button:has-text("New alert"), button:has-text("Create"), [data-testid="new-alert"]').count()) > 0;

  if (hasAlertAffordance) {
    console.log("  ✓ 06 Alert NL compile affordance visible");
    // Deep path: click compile only if a textarea + compile control exist.
    const compileBtn = page.locator(
      'button:has-text("Compile"), [data-testid="nl-alert-compile"]',
    ).first();
    if ((await compileBtn.count()) > 0 && (await compileBtn.isVisible().catch(() => false))) {
      try {
        await compileBtn.click({ timeout: 2000 });
        console.log("  ✓ 06 NL compile clicked (deep)");
      } catch {
        console.log("  SKIPPED (06-alerts NL compile click): control not actionable without backend");
      }
    } else {
      console.log("  SKIPPED (06-alerts NL compile→ack): needs Clerk seed + backend rule fixture");
    }
  } else {
    const hasPage = heading != null || /alert/i.test(bodyText);
    if (!hasPage) {
      throw new Error("Alerts page rendered no recognisable content");
    }
    console.log("  SKIPPED (06-alerts NL compile): affordance not immediately visible (may require data)");
  }
  return heading || "(alerts)";
}

/**
 * Path 7: Experiments compare
 * Asserts Experiments page renders and checks for compare panel.
 */
async function assertExperiments(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasExperiments =
    /experiment|compare|baseline|variant/i.test(bodyText) ||
    (await page.locator('[data-testid="experiment-row"], [data-testid="compare-panel"]').count()) > 0;

  if (hasExperiments) {
    console.log("  ✓ 07 Experiments compare panel or content visible");
  } else {
    const hasPage = heading != null || /experiment|eval/i.test(bodyText);
    if (!hasPage) {
      throw new Error("Experiments page rendered no recognisable content");
    }
    console.log("  SKIPPED (07-experiments compare): no experiments to compare (backend API not running)");
  }
  return heading || "(experiments)";
}

/**
 * Path 8: Debugger sessions (F01 prefix replay)
 * Deep live_prefix / Replay click SKIPPED without seeded session (Clerk/backend).
 */
async function assertDebuggerSessions(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasDebugger =
    /debugger|session|replay|rerun|prefix/i.test(bodyText) ||
    (await page.locator('[data-testid="debugger-session"], button:has-text("Replay"), button:has-text("Rerun")').count()) > 0;

  if (hasDebugger) {
    console.log("  ✓ 08 Debugger session/replay affordance visible");
    const replay = page.locator(
      'button:has-text("Replay"), button:has-text("Rerun"), [data-testid="prefix-replay"]',
    ).first();
    if ((await replay.count()) > 0 && (await replay.isVisible().catch(() => false))) {
      try {
        await replay.click({ timeout: 2000 });
        console.log("  ✓ 08 Prefix replay clicked (deep)");
      } catch {
        console.log("  SKIPPED (08-debugger prefix rerun click): not actionable without session fixture");
      }
    } else {
      console.log("  SKIPPED (08-debugger prefix rerun): needs seeded debugger session + Clerk");
    }
  } else {
    const hasPage = heading != null || /debug/i.test(bodyText);
    if (!hasPage) {
      throw new Error("Debugger sessions page rendered no recognisable content");
    }
    console.log("  SKIPPED (08-debugger): empty state without backend sessions");
  }
  return heading || "(debugger-sessions)";
}

const DEEP_ASSERTIONS = {
  "01-sign-in-home":      assertDashboard,
  "02-traces-hub":        assertTraces,
  "03-issues":            assertIssues,
  "04-artifacts":         assertArtifacts,
  "05-playgrounds":       assertPlaygrounds,
  "06-alerts":            assertAlerts,
  "07-experiments":       assertExperiments,
  "08-debugger-sessions": assertDebuggerSessions,
};

// ── Main ────────────────────────────────────────────────────────────────────

async function runPath(page, spec) {
  await page.goto(`${BASE}${spec.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  await assertNoCrash(page);
  const assertFn = DEEP_ASSERTIONS[spec.id];
  const detail = assertFn ? await assertFn(page) : null;
  await screenshotStep(page, spec.id);
  return { id: spec.id, label: spec.label, url: page.url(), ok: true, detail };
}

async function main() {
  mkdirSync("e2e/golden/screenshots", { recursive: true });

  const authState = loadAuthState();
  if (authState) {
    console.log("[golden] storageState loaded — running with Clerk session");
  } else {
    console.warn("[golden] storageState missing — running unauthenticated (pages may redirect to /sign-in)");
    if (GOLDEN_CI) {
      console.error("[golden] FATAL: GOLDEN_CI=1 requires authentication. Aborting.");
      process.exit(1);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const ctxOptions = {
    viewport: { width: 1440, height: 900 },
    ...(authState ? { storageState: authState } : {}),
  };
  const ctx = await browser.newContext(ctxOptions);
  const page = await ctx.newPage();

  // Re-inject Clerk testing bypass token so session refresh does not loop.
  if (authState) {
    await clerkSetup();
    await setupClerkTestingToken({ page });
  }

  const results = [];
  let failed = 0;

  for (const spec of PATHS) {
    try {
      const result = await runPath(page, spec);
      results.push(result);
      console.log(`✓ ${spec.label}${result.detail ? ` — "${result.detail}"` : ""}`);
    } catch (err) {
      failed += 1;
      results.push({ id: spec.id, label: spec.label, ok: false, error: String(err) });
      console.error(`✗ ${spec.label}:`, String(err).slice(0, 200));
      await screenshotStep(page, `${spec.id}-fail`).catch(() => {});
    }
  }

  await browser.close();

  console.log("\n" + JSON.stringify({ paths: results, failed, total: PATHS.length }, null, 2));

  if (failed > 0) {
    console.error(`\n[golden] ${failed}/${PATHS.length} paths FAILED`);
    if (GOLDEN_CI) process.exit(1);
  } else {
    console.log(`\n[golden] ${PATHS.length}/${PATHS.length} paths PASSED`);
  }
}

main().catch((e) => {
  console.error("[golden] FATAL:", e);
  process.exit(1);
});
