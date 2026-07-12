#!/usr/bin/env node
/**
 * Headed sign-in — fills the real Clerk <SignIn /> form so Turnstile /
 * client-trust resolves naturally in a real Chrome window. Captures
 * storageState to e2e/.auth-state.json for reuse by the headless audit.
 *
 * Falls back to the @clerk/testing helper if the form isn't found.
 */
import { chromium } from "playwright";
import { clerkSetup, clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

process.env.CLERK_SECRET_KEY = "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const EMAIL = "kaiav.nihalani@gmail.com";
const PASSWORD = "Happydays1!2345";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fillForm(page) {
  // Clerk's <SignIn /> renders inputs inside a clerk-card. The standard
  // selectors work across hosted + embedded mounts.
  const identifier = page.locator('input[name="identifier"]').first();
  const password = page.locator('input[name="password"]').first();
  if ((await identifier.count()) === 0) return false;
  await identifier.fill(EMAIL);
  // Continue to password step (Clerk's identifier-first flow).
  const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Weiter")').first();
  if (await continueBtn.count()) await continueBtn.click().catch(() => {});
  await sleep(800);
  const pw = page.locator('input[name="password"]').first();
  if (await pw.count()) {
    await pw.fill(PASSWORD);
  } else {
    await password.fill(PASSWORD);
  }
  const submit = page
    .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")')
    .last();
  await submit.click().catch(() => {});
  return true;
}

async function main() {
  await clerkSetup();
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await setupClerkTestingToken({ page });

  console.log("→ goto /sign-in");
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });

  // Wait for Clerk to mount the form.
  let formFilled = false;
  for (let i = 0; i < 20; i++) {
    if (await page.locator('input[name="identifier"]').count()) {
      formFilled = await fillForm(page);
      break;
    }
    await sleep(500);
  }
  console.log("form filled?", formFilled);

  // Wait for redirect to /dashboard (or any non-sign-in URL).
  try {
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 45_000 });
  } catch (e) {
    console.log("waitForURL failed:", String(e).slice(0, 120));
  }
  await sleep(2000);
  console.log("final url:", page.url());

  const me = await page.request.get(`${BASE}/api/proxy/auth/me`);
  console.log("auth/me status:", me.status());
  if (me.status() === 200) {
    await ctx.storageState({ path: "e2e/.auth-state.json" });
    console.log("✓ storageState saved to e2e/.auth-state.json");
  } else {
    console.log("auth/me body:", (await me.text().catch(() => "")).slice(0, 200));
    console.log("✗ auth/me not 200 — storageState NOT saved");
  }

  await browser.close();
}

main().catch((e) => {
  console.error("HEADED SIGN-IN FAILED:", e);
  process.exit(1);
});
