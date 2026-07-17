#!/usr/bin/env node
/**
 * F82 — measure LCP/INP on Home + Traces after production build.
 * Exits non-zero when samples exceed budgets in lib/perf/budgets.ts.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

const BUDGETS = {
  LCP: 2800,
  INP: 250,
};

const ROUTES = ["/dashboard", "/traces"];

function loadBudgetsFromSource() {
  try {
    const src = readFileSync(resolve(ROOT, "src/lib/perf/budgets.ts"), "utf8");
    const lcp = src.match(/LCP:\s*\{\s*max:\s*(\d+)/);
    const inp = src.match(/INP:\s*\{\s*max:\s*(\d+)/);
    return {
      LCP: lcp ? Number(lcp[1]) : BUDGETS.LCP,
      INP: inp ? Number(inp[1]) : BUDGETS.INP,
    };
  } catch {
    return BUDGETS;
  }
}

async function measureRoute(page, route, budgets) {
  const samples = { LCP: null, INP: null };
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
  }

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { domContentLoaded: n.domContentLoadedEventEnd } : null;
  });

  const failures = [];
  if (samples.LCP != null && samples.LCP > budgets.LCP) {
    failures.push({ route, name: "LCP", value: samples.LCP, max: budgets.LCP });
  }
  if (samples.INP != null && samples.INP > budgets.INP) {
    failures.push({ route, name: "INP", value: samples.INP, max: budgets.INP });
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
  console.log("✓ Web Vitals budgets OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
