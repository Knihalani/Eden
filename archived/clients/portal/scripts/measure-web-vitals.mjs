#!/usr/bin/env node
/**
 * F82 / A10 — measure LCP/INP/CLS/FCP/TTFB on Home + Traces after production build.
 * Exits non-zero when samples exceed budgets in lib/perf/budgets.ts.
 *
 * Docs: docs/specs/SOTA-PERF-COST-SCORECARD.md §6
 * CI:   .github/workflows/web-vitals.yml
 * Usage:
 *   AUTH_STATE=e2e/.auth-state.json BASE_URL=http://127.0.0.1:3000 \
 *     node scripts/measure-web-vitals.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const BUDGETS = {
  LCP: 2600,
  INP: 220,
  CLS: 0.1,
  FCP: 1800,
  TTFB: 800,
};

const ROUTES = ["/dashboard", "/traces"];

function loadBudgetsFromSource() {
  try {
    const src = readFileSync(resolve(ROOT, "src/lib/perf/budgets.ts"), "utf8");
    const num = (name) => {
      const m = src.match(new RegExp(`${name}:\\s*\\{\\s*max:\\s*([\\d.]+)`));
      return m ? Number(m[1]) : BUDGETS[name];
    };
    return {
      LCP: num("LCP"),
      INP: num("INP"),
      CLS: num("CLS"),
      FCP: num("FCP"),
      TTFB: num("TTFB"),
    };
  } catch {
    return { ...BUDGETS };
  }
}

async function measureRoute(page, route, budgets) {
  const samples = { LCP: null, INP: null, CLS: null, FCP: null, TTFB: null };
  await page.addInitScript(() => {
    window.__edenVitals = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType === "largest-contentful-paint") {
            window.__edenVitals.push({ name: "LCP", value: e.startTime });
          }
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const v = e.duration ?? e.processingStart - e.startTime;
          window.__edenVitals.push({ name: "INP", value: v });
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === "first-contentful-paint") {
            window.__edenVitals.push({ name: "FCP", value: e.startTime });
          }
        }
      }).observe({ type: "paint", buffered: true });
    } catch {}
    try {
      let cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) cls += e.value;
        }
        window.__edenVitals.push({ name: "CLS", value: cls });
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}
  });

  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.mouse.move(200, 200);
  await page.mouse.click(200, 200);
  await page.waitForTimeout(500);

  const vitals = await page.evaluate(() => window.__edenVitals || []);
  for (const v of vitals) {
    if (v.name === "LCP" && samples.LCP == null) samples.LCP = v.value;
    if (v.name === "INP") samples.INP = Math.max(samples.INP ?? 0, v.value);
    if (v.name === "FCP" && samples.FCP == null) samples.FCP = v.value;
    // CLS observer pushes cumulative totals — keep the latest.
    if (v.name === "CLS") samples.CLS = v.value;
  }

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n
      ? {
          domContentLoaded: n.domContentLoadedEventEnd,
          // TTFB ≈ responseStart on Navigation Timing
          ttfb: n.responseStart,
        }
      : null;
  });
  if (nav?.ttfb != null) samples.TTFB = nav.ttfb;

  const failures = [];
  for (const name of ["LCP", "INP", "CLS", "FCP", "TTFB"]) {
    const value = samples[name];
    const max = budgets[name];
    if (value != null && max != null && value > max) {
      failures.push({ route, name, value, max });
    }
  }

  return { route, samples, nav, failures };
}

async function main() {
  const budgets = loadBudgetsFromSource();
  const browser = await chromium.launch({ headless: true });
  const authState = process.env.AUTH_STATE;
  const ctxOpts = { viewport: { width: 1440, height: 900 } };
  if (authState) {
    try {
      ctxOpts.storageState = authState;
      console.log(`[web-vitals] using AUTH_STATE=${authState}`);
    } catch (e) {
      console.error(`[web-vitals] FATAL: could not load AUTH_STATE: ${e}`);
      process.exit(1);
    }
  } else {
    console.warn(
      "[web-vitals] AUTH_STATE unset — measuring unauthenticated shell (likely auth redirect / null LCP)",
    );
  }
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();

  const allFailures = [];
  const unmeasured = [];
  for (const route of ROUTES) {
    const result = await measureRoute(page, route, budgets);
    console.log(
      JSON.stringify({
        route: result.route,
        LCP: result.samples.LCP,
        INP: result.samples.INP,
        CLS: result.samples.CLS,
        FCP: result.samples.FCP,
        TTFB: result.samples.TTFB,
        domContentLoaded: result.nav?.domContentLoaded,
        budgets,
      }),
    );
    allFailures.push(...result.failures);
    // Auth walls / blank shells often yield null LCP — treat as a failed
    // measurement so CI cannot green-pass without real portal paint data.
    if (result.samples.LCP == null) {
      unmeasured.push(route);
    }
  }

  await browser.close();

  if (unmeasured.length) {
    console.error(
      "✗ Web Vitals: no LCP sample (likely auth redirect or empty shell):",
      unmeasured.join(", "),
    );
    console.error(
      "Hint: seed Clerk test auth (see e2e/golden/seed-auth.mjs) before measuring.",
    );
    process.exit(1);
  }
  if (allFailures.length) {
    console.error("✗ Web Vitals budget failures:", JSON.stringify(allFailures, null, 2));
    process.exit(1);
  }
  console.log("✓ Web Vitals budgets OK (LCP/INP/CLS/FCP/TTFB)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
