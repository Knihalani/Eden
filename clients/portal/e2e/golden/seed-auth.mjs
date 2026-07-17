#!/usr/bin/env node
/**
 * F85 / U20 — Headless Clerk auth seed (CI-safe).
 *
 * Uses @clerk/testing/playwright's clerkSetup() + setupClerkTestingToken() +
 * clerk.signIn() to authenticate programmatically without any UI form filling
 * or Turnstile interaction. Requires CLERK_SECRET_KEY to be set.
 *
 * On success: writes e2e/.auth-state.json (Playwright storageState).
 * On failure: exits non-zero with a clear message naming the exact required
 * env vars.
 *
 * Required env vars:
 *   CLERK_SECRET_KEY                    — Clerk secret key (sk_test_… or sk_live_…)
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY   — Clerk publishable key (pk_test_… or pk_live_…)
 *
 * The test-mode keys below are ONLY used as a fallback when neither is set in
 * the environment (local dev convenience). In CI, GitHub Actions secrets should
 * always supply these values and take precedence.
 */
import { chromium } from "playwright";
import { clerkSetup, clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(__dirname, "../..");

// Load portal .env files before resolving Clerk keys (matches Next.js build/start).
loadEnv({ path: resolve(PORTAL_ROOT, ".env.local") });
loadEnv({ path: resolve(PORTAL_ROOT, ".env") });

// ── Env config ─────────────────────────────────────────────────────────────
// CI injects keys via portal-ci.yml. Local dev loads from .env.local above.
// Fail loud when either key is missing — no silent skip.
const TEST_SECRET_KEY = "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
const TEST_PUBLISHABLE_KEY = "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";

function requireClerkKeys() {
  const allowFallback = process.env.CLERK_TEST_KEY_FALLBACK === "1";
  if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    if (
      allowFallback &&
      !process.env.CLERK_SECRET_KEY &&
      !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    ) {
      console.log("[seed-auth] CLERK_TEST_KEY_FALLBACK=1 — using committed test-mode keys");
      process.env.CLERK_SECRET_KEY = TEST_SECRET_KEY;
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = TEST_PUBLISHABLE_KEY;
      return;
    }
    const missing = [];
    if (!process.env.CLERK_SECRET_KEY) missing.push("CLERK_SECRET_KEY");
    if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) missing.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    console.error(
      `[seed-auth] FATAL: missing required Clerk env var(s): ${missing.join(", ")}\n` +
      "  Set both CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY in .env.local\n" +
      "  (or export them) before running golden paths.\n" +
      "  Build and start must use the SAME publishable key — rebuild if you changed keys:\n" +
      "    cd clients/portal && bun run build",
    );
    process.exit(1);
  }
}

requireClerkKeys();

// Clerk sign-in URL must match next.config redirects (/sign-in, not /login).
if (process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL === "/login") {
  console.warn(
    "[seed-auth] WARNING: NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login causes redirect loops.\n" +
    "  Set NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in in .env.local",
  );
}

const BASE = (process.env.BASE_URL || process.env.BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const EMAIL = process.env.CLERK_TEST_EMAIL || "kaiav.nihalani@gmail.com";
const STATE_PATH = resolve(__dirname, "../.auth-state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until Clerk is loadable (v7 may expose `loaded` late). */
async function waitForClerk(page) {
  for (let i = 0; i < 80; i++) {
    const state = await page
      .evaluate(async () => {
        const c = window.Clerk;
        if (!c) return { ready: false, reason: "no-global" };
        try {
          if (typeof c.load === "function" && !c.loaded) {
            await c.load();
          }
        } catch {
          /* load may reject on first tick */
        }
        return {
          ready: !!(c.loaded || c.session || c.user),
          loaded: !!c.loaded,
          status: c.status ?? null,
        };
      })
      .catch(() => ({ ready: false }));
    if (state.ready) return state;
    await sleep(500);
  }
  return { ready: false };
}

async function main() {
  console.log(`[seed-auth] BASE=${BASE} EMAIL=${EMAIL}`);
  console.log(`[seed-auth] storageState → ${STATE_PATH}`);

  // clerkSetup() validates the secret key against Clerk's API and configures
  // the testing token issuer. It must be called before setupClerkTestingToken.
  console.log("[seed-auth] clerkSetup()…");
  await clerkSetup();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on("pageerror", (e) => {
    const msg = String(e).slice(0, 160);
    if (!/ResizeObserver|hydration/i.test(msg)) {
      console.log("[seed-auth][pageerror]", msg);
    }
  });

  // Inject the Clerk testing bypass token BEFORE the first navigation.
  // This sets __clerk_testing_token in the request cookies so Clerk's JS
  // skips Turnstile verification on the sign-in page.
  console.log("[seed-auth] setupClerkTestingToken()…");
  await setupClerkTestingToken({ page });

  // Navigate to the sign-in page so Clerk's JS bundle loads and initialises
  // window.Clerk before we call clerk.signIn().
  console.log("[seed-auth] → goto /sign-in");
  await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Poll for window.Clerk to be available (Clerk JS loads asynchronously).
  let clerkState = await waitForClerk(page);
  console.log("[seed-auth] Clerk ready:", clerkState);

  if (!clerkState.ready) {
    // Some builds load Clerk lazily. Try navigating to / first.
    console.log("[seed-auth] Clerk not ready on /sign-in — trying /");
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    clerkState = await waitForClerk(page);
    console.log("[seed-auth] Clerk ready (retry):", clerkState);
  }

  if (!clerkState.ready) {
    const diag = await page
      .evaluate(() => ({
        hasClerkGlobal: typeof window.Clerk !== "undefined",
        scriptCount: document.querySelectorAll('script[src*="clerk"]').length,
        url: location.href,
      }))
      .catch(() => ({}));
    console.log("[seed-auth] Clerk diagnostics:", JSON.stringify(diag));
    await browser.close();
    console.error(
      "[seed-auth] FATAL: Clerk JS did not initialize.\n" +
      "  Ensure the portal was built with NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and started with CLERK_SECRET_KEY.\n" +
      "  Required env vars: CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
    process.exit(1);
  }

  // clerk.signIn uses the Clerk Backend API (via CLERK_SECRET_KEY) to create
  // a sign-in ticket, then activates the session in the browser — no form
  // filling, no Turnstile.
  console.log("[seed-auth] clerk.signIn()…");
  try {
    await clerk.signIn({ page, signInParams: { strategy: "ticket", emailAddress: EMAIL } });
  } catch (e1) {
    console.log("[seed-auth] ticket strategy threw, trying emailAddress fallback:", String(e1).slice(0, 200));
    try {
      await clerk.signIn({ page, emailAddress: EMAIL });
    } catch (e2) {
      console.log("[seed-auth] emailAddress strategy also threw:", String(e2).slice(0, 200));
    }
  }

  // Verify the session activated by waiting for __client_uat != 0.
  let sessionActive = false;
  for (let i = 0; i < 20; i++) {
    const cookies = await ctx.cookies();
    const uat = cookies.find((c) => c.name === "__client_uat")?.value;
    if (uat && uat !== "0") { sessionActive = true; break; }
    await sleep(500);
  }
  console.log("[seed-auth] session active (__client_uat != 0):", sessionActive);

  // Navigate to dashboard to confirm auth sticks and Clerk redirects there.
  console.log("[seed-auth] → goto /dashboard");
  try {
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (e) {
    console.log("[seed-auth] goto /dashboard threw:", String(e).slice(0, 120));
  }
  await sleep(1500);

  // Detect Clerk key-mismatch redirect loop (session refresh bounces to /sign-in).
  let finalUrl = page.url();
  if (/sign-in|login/.test(finalUrl)) {
    console.log("[seed-auth] still on auth after signIn — retrying with testing token on /dashboard");
    await setupClerkTestingToken({ page });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    await sleep(1500);
    finalUrl = page.url();
  }
  console.log("[seed-auth] final url:", finalUrl);

  // Confirm auth/me returns 200 (the portal backend has a session).
  const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
  const meStatus = me?.status() ?? -1;
  console.log("[seed-auth] auth/me status:", meStatus);

  if (meStatus !== 200) {
    const body = ((await me?.text().catch(() => "")) ?? "").slice(0, 300);
    console.log("[seed-auth] auth/me body:", body || "(no response body)");
    // auth/me 401/404 might mean the backend API isn't running. The Clerk
    // session itself may still be valid — check if we're on /dashboard vs /sign-in.
    const onSignIn = /sign-in/.test(finalUrl);
    if (onSignIn) {
      await browser.close();
      console.error(
        "[seed-auth] FATAL: auth failed — still on sign-in page.\n" +
        "  Common cause: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY baked at build time does not match\n" +
        "  runtime CLERK_SECRET_KEY. Rebuild the portal with the same keys:\n" +
        "    cd clients/portal && CLERK_SECRET_KEY=... NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... bun run build\n" +
        "  Required env vars: CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      );
      process.exit(1);
    }
    console.log(
      "[seed-auth] WARNING: auth/me returned non-200 (backend API likely not running).\n" +
      "  Clerk session appears valid (not on sign-in). Saving storageState anyway.\n" +
      "  Golden-path tests will see authenticated shell but empty data states.",
    );
  }

  // Save the storageState so golden-paths and a11y tests can reuse it.
  mkdirSync(resolve(__dirname, "../"), { recursive: true });
  await ctx.storageState({ path: STATE_PATH });
  console.log(`[seed-auth] ✓ storageState saved → ${STATE_PATH}`);

  await browser.close();
  console.log("[seed-auth] done.");
}

main().catch((e) => {
  console.error("[seed-auth] FATAL:", e);
  console.error(
    "\n  If this is a Clerk API error, verify:\n" +
    "    CLERK_SECRET_KEY is valid (sk_test_… for test mode)\n" +
    "    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY matches the secret key instance\n" +
    "    The test user exists in the Clerk test instance",
  );
  process.exit(1);
});
