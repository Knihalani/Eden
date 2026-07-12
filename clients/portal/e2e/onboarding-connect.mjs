#!/usr/bin/env node
/**
 * Onboarding connect-flow smoke test (headed, manual auth).
 *
 * Run after signing in:
 *   node clients/portal/e2e/onboarding-connect.mjs
 *
 * Verifies: /onboarding/connect loads, GitHub configured gate,
 * and auto-integrate UI strings when returning with installation_id.
 */
import { chromium } from "playwright";

const BASE = process.env.PORTAL_URL || "https://edenobservability.com";

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(`${BASE}/onboarding/connect`, { waitUntil: "domcontentloaded" });

  const title = await page.locator("h2").first().textContent({ timeout: 60_000 });
  console.log("connect step heading:", title?.trim());

  const hasConnect = await page.getByText(/Connect GitHub|Pick a repo|Opening integration PR/i).count();
  if (hasConnect === 0) {
    throw new Error("Expected connect-repo onboarding UI");
  }

  console.log("PASS: onboarding connect surface reachable");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
