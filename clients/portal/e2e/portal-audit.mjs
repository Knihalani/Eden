#!/usr/bin/env node
/**
 * Portal E2E audit — visits portal + public routes (excl. /docs).
 * Uses @clerk/testing; persists auth in storageState to avoid re-sign-in.
 *
 * BASE / BASE_URL:
 *   Honors env BASE (or BASE_URL) for prod audits, e.g.
 *     BASE=https://edenobservability.com node e2e/portal-audit.mjs
 *   Defaults to http://127.0.0.1:$PORT when unset.
 *
 * Auth for non-local BASE:
 *   Do not invent prod credentials. Use wait-for-signin.mjs (real Chrome) or
 *   Playwright codegen --channel=chrome to write e2e/.auth-state.json against
 *   the same origin. Localhost-seeded auth-state is invalid on prod.
 *   See e2e/README-auth.md and e2e/golden/helpers.mjs domain comments.
 *   PUBLIC_ONLY=1 skips signed-in portal routes (public smoke only).
 *
 * Routes follow the July 2026 12-item IA. Cut paths are audited as
 * redirect smoke checks (Playwright follows to the consolidated target).
 */
import { chromium } from "playwright";
import { clerkSetup, clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || "3000";
const BASE = (process.env.BASE || process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/$/,
  "",
);
const PUBLIC_ONLY = process.env.PUBLIC_ONLY === "1";
const TEST_EMAIL = process.env.E2E_EMAIL || "kaiav.nihalani@gmail.com";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "Happydays1!2345";
const STORAGE = join(__dirname, ".auth-state.json");
const ROUTE_DELAY_MS = Number(process.env.E2E_ROUTE_DELAY_MS || "2500");

const isLocal =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(BASE) ||
  BASE.includes("localhost");

// Test Clerk keys only apply to local portal — never inject them for prod audits.
if (isLocal) {
  process.env.CLERK_SECRET_KEY =
    process.env.CLERK_SECRET_KEY ||
    "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";
}

const PUBLIC_ROUTES = ["/login", "/signup", "/sign-in", "/sign-up", "/privacy", "/security", "/terms"];

/** Canonical 12-item IA + deep-link survivors used by the portal. */
const PORTAL_ROUTES = [
  // Core 12
  "/dashboard",
  "/dashboard?onboarding=1",
  "/agents",
  "/agents?tab=fleet",
  "/agents/connect",
  "/traces",
  "/traces?view=inspect",
  "/traces?view=replay",
  "/traces?view=debug",
  "/traces?view=query",
  "/issues",
  "/issues?tab=incidents",
  "/alerts",
  "/alerts?tab=signals",
  "/analytics",
  "/analytics?tab=insights",
  "/analytics?tab=topics",
  "/analytics?tab=tools",
  "/analytics?tab=users",
  "/evals",
  "/evals?tab=datasets",
  "/evals?tab=labeling",
  "/evals?tab=studio",
  "/evals?tab=synthetic",
  "/improve",
  "/improve?tab=plans",
  "/improve?tab=history",
  "/optimization",
  "/optimization?tab=budget",
  "/optimization?tab=outcomes",
  "/optimization?tab=predict",
  "/optimization?tab=advisor",
  "/guardrails",
  "/guardrails?tab=redteam",
  "/prompts",
  "/settings",
  "/settings?tab=account",
  "/settings?tab=billing",
  "/runs/test-run-id/lineage",
  // Redirect smoke (cut / consolidated routes)
  "/onboarding",
  "/onboarding/connect",
  "/inspector",
  "/replay",
  "/debugger",
  "/fleet",
  "/incidents",
  "/insights",
  "/tools",
  "/users",
  "/signals",
  "/datasets",
  "/labeling",
  "/studio",
  "/synthetic",
  "/closed-loop",
  "/autonomous",
  "/pr-suggestions",
  "/billing",
  "/profile",
  "/llmops",
  "/redteam",
  "/observability",
  "/observability/eval",
];

const BAD_VISIBLE = [
  /An unexpected error occurred/i,
  /Internal Server Error/i,
  /Maximum update depth/i,
  /Hydration failed/i,
  /Auth provider unavailable/i,
  /TypeError:/,
  /ReferenceError:/,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visibleText(page) {
  return page.locator("body *:visible").allInnerTexts().then((p) => p.join("\n"));
}

async function auditRoute(page, route, authed) {
  const result = { route, authed, status: null, consoleErrors: [], pageErrors: [], failed5xx: [], badVisible: [], ok: true };

  const onConsole = (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (!/favicon|chunk|429|too many requests/i.test(t)) result.consoleErrors.push(t.slice(0, 200));
    }
  };
  const onPageError = (err) => result.pageErrors.push(String(err).slice(0, 200));
  const onRequestFailed = (req) => {
    const url = req.url();
    if (url.includes("/api/proxy/") && /500|502|503/.test(String(req.failure()?.errorText))) {
      result.failed5xx.push(url.slice(0, 100));
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);

  try {
    const resp = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    result.status = resp?.status() ?? null;
    const isAuthRoute = /\/(login|sign-in|sign-up|signup)(\/|$)/.test(route);
    const settleMs = isAuthRoute ? 12_000 : authed && route.startsWith("/dashboard") ? 4000 : 1200;
    await sleep(settleMs);
    const text = await visibleText(page);
    let url = page.url();

    for (const pat of BAD_VISIBLE) {
      if (pat.test(text)) result.badVisible.push(pat.source);
    }

    if (/loading sign-in/i.test(text) && /sign-in|login/.test(route)) {
      // Clerk can take 5–15s on cold CDN; only flag if inputs never appeared.
      const hasForm = await page.locator(
        "input[name='identifier'], input[type='email'], input[type='password'], .cl-formButtonPrimary"
      ).count();
      if (!hasForm) result.badVisible.push("stuck auth skeleton");
    }

    if (authed) {
      const onAuthPage = /\/(login|sign-in)(\/|$)/.test(new URL(url).pathname);
      if (onAuthPage) result.badVisible.push("auth redirect while signed in");
    }

    if (result.consoleErrors.length) result.ok = false;
    if (result.pageErrors.length) result.ok = false;
    if (result.failed5xx.length) result.ok = false;
    if (result.badVisible.length) result.ok = false;
    if (result.status && result.status >= 500) result.ok = false;
  } catch (e) {
    result.ok = false;
    result.pageErrors.push(String(e).slice(0, 200));
  } finally {
    page.removeListener("console", onConsole);
    page.removeListener("pageerror", onPageError);
    page.removeListener("requestfailed", onRequestFailed);
  }

  return result;
}

async function signInViaForm(page) {
  const identifier = page.locator('input[name="identifier"]').first();
  if ((await identifier.count()) === 0) return false;
  await identifier.fill(TEST_EMAIL);
  const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Weiter")').first();
  if (await continueBtn.count()) await continueBtn.click().catch(() => {});
  await sleep(800);
  const pw = page.locator('input[name="password"]').first();
  if (await pw.count()) await pw.fill(TEST_PASSWORD);
  const submit = page
    .locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in")')
    .last();
  await submit.click().catch(() => {});
  return true;
}

async function waitForSignedIn(page, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = page.url();
    const onAuthPage = /\/(login|sign-in|sign-up|signup)(\/|$)/.test(new URL(url).pathname);
    if (!onAuthPage) {
      const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
      if (me?.status() === 200) return true;
    }
    await sleep(1000);
  }
  return false;
}

async function ensureAuth(browser) {
  if (existsSync(STORAGE)) {
    const ctx = await browser.newContext({ storageState: STORAGE, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
    const url = page.url();
    await ctx.close();
    if (me?.status() === 200 && !/\/(login|sign-in)/.test(url)) return;
  }

  // Non-local: never auto-fill credentials or inject Clerk testing tokens.
  // Capture storageState with wait-for-signin.mjs against the same BASE.
  if (!isLocal) {
    throw new Error(
      `ensureAuth: no valid e2e/.auth-state.json for BASE=${BASE}.\n` +
        "  Prod audits require cookies seeded against that origin.\n" +
        "  Run: BASE=<same> node e2e/wait-for-signin.mjs (real Chrome; manual sign-in).\n" +
        "  Do not invent production credentials; localhost auth-state is not valid on prod.",
    );
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });

  let signedIn = false;
  for (let i = 0; i < 20; i++) {
    if (await page.locator('input[name="identifier"]').count()) {
      signedIn = await signInViaForm(page);
      break;
    }
    await sleep(500);
  }

  if (!signedIn) {
    try {
      await clerk.signIn({ page, emailAddress: TEST_EMAIL, signInParams: { strategy: "password", password: TEST_PASSWORD } });
      signedIn = true;
    } catch {
      /* fall through */
    }
  }

  if (!(await waitForSignedIn(page))) {
    await ctx.close();
    throw new Error("ensureAuth: sign-in did not reach auth/me 200");
  }

  await ctx.storageState({ path: STORAGE });
  await ctx.close();
}

async function main() {
  console.log(`→ BASE=${BASE}${PUBLIC_ONLY ? " (PUBLIC_ONLY)" : ""}`);
  if (isLocal) await clerkSetup();
  const browser = await chromium.launch({ headless: true });
  const results = [];

  console.log("→ Public routes…");
  const pub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pubPage = await pub.newPage();
  if (isLocal) await setupClerkTestingToken({ page: pubPage });
  for (const route of PUBLIC_ROUTES) {
    const r = await auditRoute(pubPage, route, false);
    results.push(r);
    console.log(r.ok ? "  ✓" : "  ✗", route);
    await sleep(ROUTE_DELAY_MS);
  }
  await pub.close();

  if (!PUBLIC_ONLY) {
    console.log("→ Auth + portal routes…");
    await ensureAuth(browser);
    const ctx = await browser.newContext({ storageState: STORAGE, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    for (const route of PORTAL_ROUTES) {
      const r = await auditRoute(page, route, true);
      results.push(r);
      console.log(r.ok ? "  ✓" : "  ✗", route);
      await sleep(ROUTE_DELAY_MS);
    }
    await ctx.close();
  }
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  const outDir = join(__dirname, "reports");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `audit-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify({ base: BASE, failed: failed.length, total: results.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} OK — ${reportPath}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
