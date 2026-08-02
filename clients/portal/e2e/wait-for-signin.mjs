#!/usr/bin/env node
/**
 * Opens a headed browser on /sign-in and waits for you to sign in manually.
 * Saves Playwright storageState to e2e/.auth-state.json when /api/proxy/auth/me
 * returns 200 — reuse with portal-audit.mjs.
 *
 * Clerk blocks Playwright's bundled Chromium ("browser not supported /
 * insecure") on production. This script uses your installed Google Chrome
 * by default when BASE is not localhost.
 *
 * Usage:
 *   # Production (manual sign-in in real Chrome window):
 *   BASE=https://edenobservability.com node e2e/wait-for-signin.mjs
 *
 *   # Local dev (test Clerk + testing token bypass):
 *   BASE=http://127.0.0.1:3000 node e2e/wait-for-signin.mjs
 *
 * Env:
 *   PW_CHANNEL=chrome|msedge|chromium  — browser to launch (default: chrome for prod)
 *   E2E_SIGNIN_WAIT_MS=300000          — max wait for sign-in
 *   CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — only for local test Clerk
 */
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const STORAGE = join(__dirname, ".auth-state.json");
const MAX_WAIT_MS = Number(process.env.E2E_SIGNIN_WAIT_MS || "300000");

const isLocal =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE) ||
  BASE.includes("localhost");

// Local Clerk testing requires keys from the environment (never committed).
if (isLocal) {
  for (const name of ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]) {
    if (!process.env[name]) {
      console.error(`[wait-for-signin] FATAL: missing required env ${name} for local BASE`);
      process.exit(1);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function maybeSetupClerkTesting(page) {
  if (!isLocal) return;
  try {
    const { clerkSetup, setupClerkTestingToken } = await import(
      "@clerk/testing/playwright"
    );
    await clerkSetup();
    await setupClerkTestingToken({ page });
    console.log("✓ Clerk testing token applied (local test instance)");
  } catch (e) {
    console.warn(
      "⚠ @clerk/testing not available — install with: bun add -D @clerk/testing",
    );
    console.warn(String(e).slice(0, 120));
  }
}

function launchOptions() {
  const channel =
    process.env.PW_CHANNEL ||
    (isLocal ? undefined : "chrome");

  const opts = {
    headless: false,
    slowMo: 30,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  if (channel && channel !== "chromium") {
    opts.channel = channel;
  }

  return opts;
}

async function main() {
  const opts = launchOptions();
  console.log(`\n→ Launching browser (channel=${opts.channel || "bundled chromium"})`);
  console.log(`→ BASE=${BASE}`);
  if (!isLocal) {
    console.log(
      "  Production mode: sign in manually in the Chrome window.",
    );
    console.log(
      "  Clerk testing tokens do NOT work on live Clerk — real sign-in required.\n",
    );
  }

  const browser = await chromium.launch(opts);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: opts.channel
      ? undefined
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  await maybeSetupClerkTesting(page);

  console.log(`→ Opened ${BASE}/sign-in — sign in in the browser window.`);
  console.log(`  Waiting up to ${MAX_WAIT_MS / 1000}s for auth/me → 200…\n`);
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });

  const started = Date.now();
  let saved = false;
  while (Date.now() - started < MAX_WAIT_MS) {
    const url = page.url();
    let pathname = "/";
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* ignore */
    }
    const onAuthPage = /\/(login|sign-in|sign-up|signup)(\/|$)/.test(pathname);
    if (!onAuthPage) {
      const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
      if (me?.status() === 200) {
        await ctx.storageState({ path: STORAGE });
        console.log(`✓ Signed in (${url}) — saved ${STORAGE}`);
        saved = true;
        break;
      }
      if (me?.status() >= 500) {
        const body = (await me.text().catch(() => "")).slice(0, 200);
        console.log(`  auth/me ${me.status()}: ${body}`);
      }
    }
    await sleep(2000);
  }

  if (!saved) {
    console.error(
      "\n✗ Timed out — auth/me never returned 200.\n" +
        "  If Clerk showed 'browser not supported':\n" +
        "    PW_CHANNEL=chrome BASE=https://edenobservability.com node e2e/wait-for-signin.mjs\n" +
        "  Or use Playwright codegen (see e2e/README-auth.md).\n",
    );
    await browser.close();
    process.exit(1);
  }

  console.log("→ Keeping browser open 5s, then closing…");
  await sleep(5000);
  await browser.close();
  console.log(`\nNext: BASE=${BASE} node e2e/portal-audit.mjs\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
