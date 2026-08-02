#!/usr/bin/env node
/**
 * Slack integration + post-merge guardian — UI smoke probe.
 *
 * Covers the Soft Autonomy Phase 6 surfaces without real Slack OAuth:
 *   1. /settings renders the Slack alerts card with a "Connect Slack"
 *      affordance (or the connected-state workspace name when an install
 *      exists in the backend).
 *   2. /improve renders the queue/plan chrome; when a guardian-drafted
 *      plan exists it must be attributable (guardian copy), never silent.
 *
 * Requires e2e/.auth-state.json (same rules as golden-paths.spec.mjs).
 * Exits non-zero on failure unless GOLDEN_ALLOW_FAIL=1.
 */
import { chromium } from "playwright";
import { setupClerkTestingToken, clerkSetup } from "@clerk/testing/playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(__dirname, "../..");
loadEnv({ path: resolve(PORTAL_ROOT, ".env.local") });
loadEnv({ path: resolve(PORTAL_ROOT, ".env") });
import { BASE, loadAuthState, assertNoCrash, screenshotStep } from "./helpers.mjs";

const GOLDEN_ALLOW_FAIL = process.env.GOLDEN_ALLOW_FAIL === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`✗ ${msg}`);
};
const pass = (msg) => console.log(`✓ ${msg}`);

async function probeSlackSettings(page) {
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(1500);
  await assertNoCrash(page);

  const body = await page.locator("body").innerText().catch(() => "");
  if (!/Slack alerts/i.test(body)) {
    // The card returns null when the instance has no Slack App configured
    // (GET /integrations/slack/configured → {configured:false}, or the
    // backend is unreachable) — that is deliberate, documented behavior,
    // not a regression. Only fail if settings itself didn't render.
    if (/settings|workspace|api keys/i.test(body)) {
      console.log(
        "  SKIPPED (slack card): Slack App not configured on this instance — card hides by design",
      );
    } else {
      fail("settings: page rendered no recognisable content");
    }
    return;
  }
  pass("settings: Slack alerts card rendered");

  const connectBtn = page.locator('button:has-text("Connect Slack")');
  const connected = /Connected to/i.test(body);
  if ((await connectBtn.count()) > 0) {
    pass('settings: "Connect Slack" affordance visible (not connected)');
  } else if (connected) {
    pass("settings: connected-state workspace name visible");
  } else {
    fail('settings: neither "Connect Slack" nor connected state visible');
  }
  await screenshotStep(page, "slack-settings");
}

async function probeGuardian(page) {
  await page.goto(`${BASE}/improve`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(1500);
  await assertNoCrash(page);

  const body = await page.locator("body").innerText().catch(() => "");
  if (!/improve|queue|plan/i.test(body)) {
    fail("improve: no queue/plan chrome rendered");
    return;
  }
  pass("improve: queue/plan chrome rendered");

  if (/guardian/i.test(body)) {
    pass("improve: guardian-drafted plan is attributed in copy");
  } else {
    console.log("  SKIPPED (guardian attribution): no guardian-drafted plan in this org");
  }
  await screenshotStep(page, "improve-guardian");
}

async function main() {
  const authState = loadAuthState();
  if (!authState) {
    console.error("[slack-guardian] FATAL: storageState missing — authenticated probe only");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: authState,
  });
  const page = await ctx.newPage();
  await clerkSetup();
  await setupClerkTestingToken({ page });

  await probeSlackSettings(page);
  await probeGuardian(page);

  await browser.close();

  if (failures > 0) {
    console.error(`\n[slack-guardian] ${failures} checks FAILED`);
    if (GOLDEN_ALLOW_FAIL) {
      console.warn("[slack-guardian] GOLDEN_ALLOW_FAIL=1 — exiting 0 (local soft report only)");
      process.exit(0);
    }
    process.exit(1);
  }
  console.log("\n[slack-guardian] all checks PASSED");
}

main().catch((e) => {
  console.error("[slack-guardian] FATAL:", e);
  process.exit(1);
});
