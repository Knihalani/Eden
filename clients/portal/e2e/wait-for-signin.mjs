#!/usr/bin/env node
/**
 * Opens a headed Chrome window on /sign-in and waits for the user to
 * complete sign-in manually. Saves storageState when /api/proxy/auth/me
 * returns 200, then exits so the headless audit can reuse the session.
 */
import { chromium } from "playwright";
import { clerkSetup } from "@clerk/testing/playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const STORAGE = join(__dirname, ".auth-state.json");
const MAX_WAIT_MS = Number(process.env.E2E_SIGNIN_WAIT_MS || "300000");

process.env.CLERK_SECRET_KEY =
  process.env.CLERK_SECRET_KEY ||
  "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await clerkSetup();
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  console.log(`\n→ Opened ${BASE}/sign-in — sign in manually in the browser window.`);
  console.log(`  Waiting up to ${MAX_WAIT_MS / 1000}s for auth/me to return 200…\n`);
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });

  const started = Date.now();
  let saved = false;
  while (Date.now() - started < MAX_WAIT_MS) {
    const url = page.url();
    const onAuthPage = /\/(login|sign-in|sign-up|signup)(\/|$)/.test(new URL(url).pathname);
    if (!onAuthPage) {
      const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
      if (me?.status() === 200) {
        await ctx.storageState({ path: STORAGE });
        console.log(`✓ Signed in (${url}) — storageState saved to e2e/.auth-state.json`);
        saved = true;
        break;
      }
    }
    await sleep(2000);
  }

  if (!saved) {
    console.error("✗ Timed out — auth/me never returned 200. Close the browser and retry.");
    await browser.close();
    process.exit(1);
  }

  console.log("→ Keeping browser open 5s so you can confirm, then closing…");
  await sleep(5000);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
