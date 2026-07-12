#!/usr/bin/env node
/**
 * Portal E2E audit — visits portal + public routes (excl. /docs).
 * Uses @clerk/testing; persists auth in storageState to avoid re-sign-in.
 */
import { chromium } from "playwright";
import { clerkSetup, clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_EMAIL = process.env.E2E_EMAIL || "kaiav.nihalani@gmail.com";
const STORAGE = join(__dirname, ".auth-state.json");
const ROUTE_DELAY_MS = Number(process.env.E2E_ROUTE_DELAY_MS || "2500");

process.env.CLERK_SECRET_KEY =
  process.env.CLERK_SECRET_KEY ||
  "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";

const PUBLIC_ROUTES = ["/login", "/signup", "/sign-in", "/sign-up", "/privacy", "/security", "/terms"];
const PORTAL_ROUTES = [
  "/dashboard", "/observability", "/observability/query", "/observability/cohorts",
  "/observability/decisions", "/observability/memory", "/observability/retrieval",
  "/observability/apm", "/observability/eval", "/observability/time-travel",
  "/traces", "/llmops", "/optimization", "/optimization/budget",
  "/optimization/model-advisor", "/optimization/outcomes", "/optimization/predict",
  "/settings", "/settings/sidebar", "/settings/exports", "/settings/gateway",
  "/settings/pii", "/settings/retention", "/settings/webhooks-dlq",
  "/onboarding", "/onboarding/org", "/onboarding/connect", "/onboarding/install",
  "/onboarding/autonomous", "/onboarding/tour", "/onboarding/done", "/onboarding/wait",
  "/agents", "/agents/connect", "/alerts", "/billing", "/guardrails",
  "/insights", "/pr-suggestions", "/users", "/tools", "/datasets", "/debugger",
  "/replay", "/studio", "/synthetic", "/multi-agent", "/marketplace", "/closed-loop",
  "/incidents", "/signals", "/labeling", "/inspector", "/prompts", "/redteam",
  "/profile", "/builder", "/analytics", "/autonomous", "/runs/test-run-id/lineage",
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
    const settleMs = isAuthRoute ? 12_000 : authed && route === "/dashboard" ? 4000 : 1200;
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

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await setupClerkTestingToken({ page });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await clerk.signIn({ page, emailAddress: TEST_EMAIL });
  await sleep(2000);
  await ctx.storageState({ path: STORAGE });
  await ctx.close();
}

async function main() {
  await clerkSetup();
  const browser = await chromium.launch({ headless: true });
  const results = [];

  console.log("→ Public routes…");
  const pub = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pubPage = await pub.newPage();
  await setupClerkTestingToken({ page: pubPage });
  for (const route of PUBLIC_ROUTES) {
    results.push(await auditRoute(pubPage, route, false));
    await sleep(ROUTE_DELAY_MS);
  }
  await pub.close();

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
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  const outDir = join(__dirname, "reports");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `audit-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify({ failed: failed.length, total: results.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} OK — ${reportPath}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
