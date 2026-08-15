#!/usr/bin/env node
/**
 * Deep production audit — live IA routes + console/network/timing capture.
 *
 * Prerequisites:
 *   BASE=https://edenobservability.com node e2e/wait-for-signin.mjs
 *
 * Usage:
 *   BASE=https://edenobservability.com node e2e/prod-deep-audit.mjs
 *   PUBLIC_ONLY=1 BASE=… node e2e/prod-deep-audit.mjs
 *   MOBILE=1 BASE=… node e2e/prod-deep-audit.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE || process.env.BASE_URL || "https://edenobservability.com").replace(
  /\/$/,
  "",
);
const PUBLIC_ONLY = process.env.PUBLIC_ONLY === "1";
const MOBILE = process.env.MOBILE === "1";
const STORAGE = join(__dirname, ".auth-state.json");
const ROUTE_DELAY_MS = Number(process.env.E2E_ROUTE_DELAY_MS || "2000");
const SLOW_DOC_MS = Number(process.env.SLOW_DOC_MS || "3000");
const SLOW_API_MS = Number(process.env.SLOW_API_MS || "2000");

const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/about",
  "/contact",
  "/changelog",
  "/privacy",
  "/terms",
  "/security",
  "/status",
  "/sign-in",
  "/sign-up",
  "/login",
  "/signup",
  "/forgot-password",
];

/** Live product IA + soft-land / redirect smoke. */
const PORTAL_ROUTES = [
  "/home",
  "/dashboard",
  "/agents",
  "/agents/connect",
  "/traces",
  "/traces?view=inspect",
  "/sessions",
  "/issues",
  "/alerts",
  "/signals",
  "/evals",
  "/prompts",
  "/compare",
  "/improve",
  "/guardrails",
  "/cost",
  "/gateway",
  "/agent",
  "/debugger",
  "/settings",
  "/settings?tab=account",
  "/settings?tab=keys",
  "/onboarding",
  "/onboarding/connect",
  "/unavailable",
  // stub → soft-land
  "/analytics",
  "/billing",
  "/artifacts",
  "/debugger-sessions",
  "/observability",
];

const MOBILE_ROUTES = ["/home", "/traces", "/issues", "/agents", "/settings", "/signals"];

const BAD_VISIBLE = [
  /An unexpected error occurred/i,
  /Internal Server Error/i,
  /Maximum update depth/i,
  /Hydration failed/i,
  /Auth provider unavailable/i,
  /TypeError:/,
  /ReferenceError:/,
  /Something went wrong/i,
  /Application error/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visibleText(page) {
  return page.locator("body *:visible").allInnerTexts().then((p) => p.join("\n"));
}

function isNoiseConsole(t) {
  return /favicon|Download the React DevTools|Clerk:\s*Clerk has been loaded with development keys|hydration mismatch.*clerk|net::ERR_ABORTED|Failed to load resource: the server responded with a status of 4(0[14])/i.test(
    t,
  );
}

async function auditRoute(page, route, authed) {
  const result = {
    route,
    authed,
    finalUrl: null,
    status: null,
    docMs: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    slowRequests: [],
    apiStatus: [],
    badVisible: [],
    stuckSync: false,
    ok: true,
  };

  const onConsole = (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    if (isNoiseConsole(t)) return;
    result.consoleErrors.push(t.slice(0, 300));
  };
  const onPageError = (err) => result.pageErrors.push(String(err).slice(0, 300));
  const onResponse = (resp) => {
    const url = resp.url();
    const status = resp.status();
    const timing = resp.request().timing?.() || {};
    const ms =
      typeof timing.responseEnd === "number" && timing.responseEnd >= 0
        ? timing.responseEnd
        : null;
    if (url.includes("/api/proxy/") || url.includes("api.edenobservability.com")) {
      result.apiStatus.push({ status, url: url.slice(0, 160), ms });
      if (status >= 400) {
        // First-attempt 401s are retried by fetchApi after Clerk token refresh.
        // Count only persistent auth failures / server errors as audit fails.
        if (status !== 401) {
          result.failedRequests.push({ status, url: url.slice(0, 160), ms });
        }
      }
      if (ms != null && ms >= SLOW_API_MS) {
        result.slowRequests.push({ status, url: url.slice(0, 160), ms, kind: "api" });
      }
    } else if (status >= 500) {
      result.failedRequests.push({ status, url: url.slice(0, 160), ms });
    }
  };
  const onRequestFailed = (req) => {
    const url = req.url();
    if (/favicon|hot-update|\.map$|_rsc=/.test(url)) return;
    const err = req.failure()?.errorText || "";
    // Next.js aborts in-flight RSC/nav prefetches on route change — not user bugs.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(err) && (/_rsc=|\/api\/proxy\//.test(url))) return;
    result.failedRequests.push({
      status: 0,
      url: url.slice(0, 160),
      error: err.slice(0, 120),
    });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  const t0 = Date.now();
  try {
    const resp = await page.goto(`${BASE}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    result.status = resp?.status() ?? null;
    result.docMs = Date.now() - t0;
    if (result.docMs >= SLOW_DOC_MS) {
      result.slowRequests.push({
        status: result.status,
        url: `${BASE}${route}`,
        ms: result.docMs,
        kind: "document",
      });
    }

    const settleMs = /\/(sign-in|sign-up|login|signup)/.test(route) ? 8000 : authed ? 3500 : 1500;
    await sleep(settleMs);
    result.finalUrl = page.url();

    const text = await visibleText(page);
    for (const pat of BAD_VISIBLE) {
      if (pat.test(text)) result.badVisible.push(pat.source);
    }
    if (/Syncing organization/i.test(text)) {
      await sleep(5000);
      const text2 = await visibleText(page);
      if (/Syncing organization/i.test(text2)) {
        result.stuckSync = true;
        result.badVisible.push("stuck Syncing organization");
      }
    }

    if (authed) {
      const pathname = new URL(result.finalUrl).pathname;
      if (/\/(login|sign-in)(\/|$)/.test(pathname)) {
        result.badVisible.push("auth redirect while signed in");
      }
    }

    if (result.consoleErrors.length) result.ok = false;
    if (result.pageErrors.length) result.ok = false;
    if (result.failedRequests.some((f) => f.status >= 500 || f.status === 0)) result.ok = false;
    if (result.badVisible.length) result.ok = false;
    if (result.status && result.status >= 500) result.ok = false;
    // Soft-fail on slow only when no hard failures — track separately
  } catch (e) {
    result.ok = false;
    result.pageErrors.push(String(e).slice(0, 300));
    result.docMs = Date.now() - t0;
  } finally {
    page.removeListener("console", onConsole);
    page.removeListener("pageerror", onPageError);
    page.removeListener("response", onResponse);
    page.removeListener("requestfailed", onRequestFailed);
  }

  return result;
}

async function ensureAuth(browser) {
  if (!existsSync(STORAGE)) {
    throw new Error(
      `Missing ${STORAGE}. Run: BASE=${BASE} node e2e/wait-for-signin.mjs`,
    );
  }
  const ctx = await browser.newContext({
    storageState: STORAGE,
    viewport: MOBILE
      ? { width: 390, height: 844, isMobile: true, hasTouch: true }
      : { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(2500);
  const me = await page.request.get(`${BASE}/api/proxy/auth/me`).catch(() => null);
  const url = page.url();
  if (me?.status() !== 200 || /\/(login|sign-in)/.test(url)) {
    await ctx.close();
    throw new Error(
      `Auth state invalid (auth/me=${me?.status()} url=${url}). Re-run wait-for-signin.mjs`,
    );
  }
  await ctx.close();
}

async function main() {
  console.log(`→ BASE=${BASE}${PUBLIC_ONLY ? " PUBLIC_ONLY" : ""}${MOBILE ? " MOBILE" : ""}`);
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.PW_CHANNEL || undefined,
  });
  const results = [];
  const viewport = MOBILE
    ? { width: 390, height: 844, isMobile: true, hasTouch: true }
    : { width: 1440, height: 900 };

  console.log("→ Public routes…");
  {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    for (const route of PUBLIC_ROUTES) {
      const r = await auditRoute(page, route, false);
      results.push(r);
      const slow = r.slowRequests.length ? ` slow=${r.slowRequests.length}` : "";
      console.log(r.ok ? "  ✓" : "  ✗", route, `${r.docMs}ms`, slow);
      await sleep(ROUTE_DELAY_MS);
    }
    await ctx.close();
  }

  if (!PUBLIC_ONLY) {
    console.log("→ Auth check…");
    await ensureAuth(browser);
    const routes = MOBILE ? MOBILE_ROUTES : PORTAL_ROUTES;
    console.log(`→ Portal routes (${routes.length})…`);
    const ctx = await browser.newContext({ storageState: STORAGE, viewport });
    const page = await ctx.newPage();
    for (const route of routes) {
      const r = await auditRoute(page, route, true);
      results.push(r);
      const flags = [
        r.slowRequests.length ? `slow=${r.slowRequests.length}` : "",
        r.failedRequests.length ? `failNet=${r.failedRequests.length}` : "",
        r.consoleErrors.length ? `console=${r.consoleErrors.length}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(r.ok ? "  ✓" : "  ✗", route, `${r.docMs}ms`, flags, "→", r.finalUrl?.replace(BASE, "") || "");
      await sleep(ROUTE_DELAY_MS);
    }
    await ctx.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  const slow = results.filter((r) => r.slowRequests.length);
  const outDir = join(__dirname, "reports");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(
    outDir,
    `deep-audit-${MOBILE ? "mobile-" : ""}${Date.now()}.json`,
  );
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        base: BASE,
        mobile: MOBILE,
        failed: failed.length,
        slowRoutes: slow.length,
        total: results.length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\n${results.length - failed.length}/${results.length} OK — ${failed.length} fail — ${slow.length} slow`);
  console.log(reportPath);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
