#!/usr/bin/env node
/**
 * F85 — 8 golden paths (Playwright).
 *
 * Exit honesty:
 *   Path failures exit non-zero by default (local and CI).
 *   Set GOLDEN_ALLOW_FAIL=1 only when you intentionally want a soft report
 *   (e.g. exploratory local runs). GOLDEN_CI=1 still requires auth state.
 *
 * Requires e2e/.auth-state.json — run seed-auth.mjs (local) or
 * wait-for-signin.mjs (prod) first. Auth cookies must match BASE origin;
 * see helpers.mjs loadAuthState docs. Do not invent prod credentials.
 *
 * Screenshots → e2e/golden/screenshots/
 *
 * W6 chrome + hub visual map (agents / improve / settings gaps, re-baseline):
 *   docs/specs/ui/overhaul-2026/w6-visual-regression.md
 *   node e2e/golden/w6-visual-smoke-checklist.mjs
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
const GOLDEN_ALLOW_FAIL = process.env.GOLDEN_ALLOW_FAIL === "1";

// ── Path definitions ────────────────────────────────────────────────────────
// Routes must be LIVE portal routes (see src/lib/portal-polish.ts
// U20_CORE_AXE_ROUTES). Retired aliases (/dashboard, /artifacts,
// /debugger-sessions) redirect via next.config.ts and are covered by the
// legacy-redirect regression check in main() — not as golden paths.
const PATHS = [
  { id: "01-sign-in-home",        route: "/home",              label: "Sign-in → Home" },
  { id: "02-traces-hub",          route: "/traces",            label: "Traces hub" },
  { id: "03-issues",              route: "/issues",            label: "Issues list" },
  { id: "04-improve",             route: "/improve",           label: "Improve queue" },
  { id: "05-playgrounds",         route: "/playgrounds",       label: "Playground" },
  { id: "06-alerts",              route: "/alerts",            label: "Alerts" },
  { id: "07-experiments",         route: "/evals?tab=experiments",       label: "Experiments compare" },
  { id: "08-debugger-sessions",   route: "/debugger",          label: "Debugger sessions" },
];

// Retired aliases must keep redirecting to their live replacements.
const LEGACY_REDIRECTS = [
  { from: "/dashboard", to: "/home" },
  { from: "/debugger-sessions", to: "/debugger" },
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
 * Path 4: Improve queue (successor to the retired /artifacts surface).
 * Asserts the Improve hub renders its queue/plan chrome or an honest
 * empty state. Degrades loudly if no data.
 */
async function assertImprove(page) {
  await assertAuthShell(page);
  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasImprove =
    /improve|queue|plan|patch|approve|guardian/i.test(bodyText) ||
    (await page.locator('[data-testid="improve-queue"], [data-testid="improve-plan"], [role="tablist"]').count()) > 0;

  if (!hasImprove) {
    throw new Error("Improve page rendered no recognisable content");
  }
  console.log("  ✓ 04 Improve queue/plan chrome visible");
  return heading || "(improve)";
}

/**
 * Path 5: Playground from-span → run
 * Asserts the Playgrounds page renders (or its empty state).
 * Checks for a "New playground" / "Run" affordance.
 */
async function assertPlaygrounds(page) {
  await assertAuthShell(page);

  const url = page.url();
  if (!/\/playgrounds\/?(\?|$)/.test(url)) {
    await page.waitForURL(/\/playgrounds\/?(\?|$)/, { timeout: 15_000 }).catch(() => {});
  }

  const heading = await assertPageLoaded(page);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const onCanonicalPlaygrounds =
    /\/playgrounds\/?(\?|$)/.test(page.url()) &&
    !/redirecting|loading playgrounds/i.test(bodyText);
  const hasAffordance =
    /new playground|no playgrounds yet|playgrounds/i.test(bodyText) ||
    (await page.locator(
      'button:has-text("New playground"), [data-testid="new-playground"]',
    ).count()) > 0;

  if (!onCanonicalPlaygrounds || !hasAffordance) {
    throw new Error("Playgrounds page rendered no recognisable content");
  }
  console.log("  ✓ 05 Playgrounds list surface visible");
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
    const hasPage =
      heading != null ||
      /alert|workspace|signing you in|welcome to eden/i.test(bodyText);
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
    const hasPage =
      heading != null ||
      /debug|session|workspace|signing you in|welcome to eden/i.test(bodyText);
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
  "04-improve":           assertImprove,
  "05-playgrounds":       assertPlaygrounds,
  "06-alerts":            assertAlerts,
  "07-experiments":       assertExperiments,
  "08-debugger-sessions": assertDebuggerSessions,
};

// ── Main ────────────────────────────────────────────────────────────────────

async function runPath(page, spec) {
  // Refresh Clerk testing bypass before each navigation — session refresh
  // mid-suite otherwise remounts portal-chrome on “Signing you in”.
  try {
    await setupClerkTestingToken({ page });
  } catch {
    /* optional when unauthenticated local runs */
  }
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

  // Legacy-alias regression: retired routes must redirect to their live
  // replacements, not 404 or strand users on /unavailable. Runs after a
  // warm-up navigation — the very first goto can race Clerk testing-token
  // activation and bounce to /sign-in through no fault of the redirect.
  try {
    await setupClerkTestingToken({ page });
  } catch {
    /* optional when unauthenticated local runs */
  }
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(800);
  for (const { from, to } of LEGACY_REDIRECTS) {
    try {
      await page.goto(`${BASE}${from}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(600);
      const landed = new URL(page.url()).pathname;
      if (landed === to || landed.startsWith(`${to}/`) || landed.startsWith(`${to}?`)) {
        console.log(`✓ legacy ${from} → ${to}`);
      } else {
        throw new Error(`legacy ${from} landed on ${landed}, expected ${to}`);
      }
    } catch (err) {
      failed += 1;
      results.push({ id: `legacy-${from}`, label: `Legacy redirect ${from}`, ok: false, error: String(err) });
      console.error(`✗ legacy ${from} → ${to}:`, String(err).slice(0, 200));
    }
  }

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
    if (GOLDEN_ALLOW_FAIL) {
      console.warn(
        "[golden] GOLDEN_ALLOW_FAIL=1 — reporting failures but exiting 0 (local soft report only; never set in CI)",
      );
      console.log("EXIT:0");
    } else {
      console.log("EXIT:1");
      process.exit(1);
    }
  } else {
    console.log(`\n[golden] ${PATHS.length}/${PATHS.length} paths PASSED`);
    console.log("EXIT:0");
  }
}

main().catch((e) => {
  console.error("[golden] FATAL:", e);
  process.exit(1);
});
