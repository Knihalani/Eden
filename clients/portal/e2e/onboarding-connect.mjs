#!/usr/bin/env node
/**
 * Product tour smoke test (headed, manual auth).
 *
 * Run after signing in:
 *   node clients/portal/e2e/onboarding-connect.mjs
 *
 * Verifies: /dashboard?onboarding=1 opens the product tour
 * and Skip / Start tour controls are present.
 */
import { chromium } from "playwright";

const BASE = process.env.PORTAL_URL || "https://edenobservability.com";

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(`${BASE}/dashboard?onboarding=1`, { waitUntil: "domcontentloaded" });

  const welcome = await page.getByText(/Welcome to Eden/i).first().textContent({ timeout: 60_000 });
  console.log("tour welcome:", welcome?.trim());

  const hasSkip = await page.getByText(/Skip tour/i).count();
  const hasStart = await page.getByRole("button", { name: /Start tour|Next/i }).count();
  if (hasSkip === 0 && hasStart === 0) {
    throw new Error("Expected product tour UI on /dashboard?onboarding=1");
  }

  const startBtn = page.getByRole("button", { name: /Start tour/i }).first();
  if (await startBtn.count()) {
    await startBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    const dashStep = await page.getByText(/Dashboard/i).count();
    console.log("advanced past welcome:", dashStep > 0);
  }

  console.log("PASS: product tour reachable via /dashboard?onboarding=1");
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
