#!/usr/bin/env node
/**
 * Axe gate — Playwright + axe-core with the saved Clerk storageState
 * (e2e/.auth-state.json) against the running portal server, auditing the
 * live authenticated portal routes (WCAG 2.2 AA).
 *
 * There is deliberately no unauthenticated fallback: without storageState
 * every portal route renders the /sign-in stub and the audit would report
 * a false pass (this gate shipped "0 violations" for months that way).
 * Missing/expired storageState exits 2 with instructions; a route that
 * redirects to sign-in or soft-lands on /unavailable fails the run.
 *
 * Usage:
 *   node e2e/golden/seed-auth.mjs   # refresh storageState first
 *   PORT=3000 bun run audit:a11y
 *
 * Fails on any critical violation, on serious violations for gated routes
 * (SERIOUS_GATE_ROUTES), and on any route that could not be audited
 * truthfully.
 */
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = process.env.PORT || "3000";
// Live portal leaves only (2026-08-01). Retired routes (/dashboard,
// /artifacts, /playgrounds, /ledger, /optimization) soft-land to
// /unavailable or /home — auditing them measured the redirect target,
// not a real surface, and produced false-pass reports.
const ROUTES = [
  "/home",
  "/traces",
  "/issues",
  "/sessions",
  "/evals",
  "/improve",
  "/agents",
  "/compare",
  "/cost",
  "/gateway",
  "/signals",
  "/prompts",
  "/guardrails",
  "/settings",
];
/** Fail the gate on serious violations for the highest-traffic surfaces. */
const SERIOUS_GATE_ROUTES = new Set([
  "/traces",
  "/improve",
  "/evals",
  "/issues",
  "/prompts",
  "/guardrails",
]);
const BLOCKING_IMPACTS = new Set(["critical"]);
const STATE_PATH = path.join(__dirname, "../e2e/.auth-state.json");

function pingServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 1000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Dev server not reachable on :${port} after ${timeoutMs}ms`));
        } else {
          setTimeout(tick, 1000);
        }
      });
      req.on("timeout", () => req.destroy());
    };
    tick();
  });
}

/**
 * Authenticated audit via Playwright + axe-core injected into the page.
 * Runs with the saved Clerk storageState so the real authenticated shell
 * renders instead of the /sign-in redirect.
 */
async function runAxeWithAuth(routes, storageState) {
  const { chromium } = require("playwright");
  const axeSourcePath = require.resolve("axe-core");
  const axeSource = fs.readFileSync(axeSourcePath, "utf8");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState,
  });
  const page = await ctx.newPage();
  const results = [];

  for (const route of routes) {
    const url = `http://127.0.0.1:${PORT}${route}`;
    console.log(`[audit:a11y] → ${url} (authenticated)`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Wait for React to hydrate
      await page.waitForTimeout(2000);

      // Truthfulness guard: if the route bounced to /sign-in (expired or
      // invalid storageState) or soft-landed on /unavailable, axe would be
      // auditing the wrong page and reporting a false pass. Record it as a
      // failure instead of a clean bill.
      const landed = page.url();
      if (landed.includes("/sign-in") || landed.includes("/sign-up")) {
        console.error(
          `[audit:a11y] ${route}: redirected to sign-in — storageState is missing/expired. ` +
            `Run e2e/golden/seed-auth.mjs to refresh it.`,
        );
        results.push({ route, ok: false, critical: 0, serious: 0, error: "auth-redirect" });
        continue;
      }
      if (landed.includes("/unavailable")) {
        console.error(`[audit:a11y] ${route}: soft-landed on /unavailable — stale route in ROUTES list.`);
        results.push({ route, ok: false, critical: 0, serious: 0, error: "soft-landed" });
        continue;
      }

      // Inject axe-core into the page
      await page.addScriptTag({ content: axeSource });

      // Run axe analysis
      const axeResults = await page.evaluate(async () => {
        return await window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        });
      });

      const violations = axeResults.violations || [];
      const critical = violations.filter((v) => v.impact === "critical").length;
      const serious = violations.filter((v) => v.impact === "serious").length;
      const seriousGate = SERIOUS_GATE_ROUTES.has(route);

      // Log any critical violations with details for debugging
      if (critical > 0) {
        for (const v of violations.filter((v) => v.impact === "critical")) {
          console.error(
            `[audit:a11y]   CRITICAL: ${v.id} — ${v.description}\n` +
            `    Nodes: ${v.nodes.slice(0, 2).map((n) => n.html?.slice(0, 120)).join(", ")}`,
          );
        }
      }
      if (serious > 0) {
        for (const v of violations.filter((v) => v.impact === "serious")) {
          const tag = seriousGate ? "SERIOUS(gate)" : "serious";
          console.warn(
            `[audit:a11y]   ${tag}: ${v.id} — ${v.description}`,
          );
        }
      }

      const ok = critical === 0 && (!seriousGate || serious === 0);
      console.log(
        `[audit:a11y] ${route}: ${critical} critical, ${serious} serious` +
          (seriousGate ? " (serious gated)" : ""),
      );
      results.push({ route, ok, critical, serious, seriousGate, violations: violations.length });

      // Save JSON report for CI artifact (gitignored run-artifacts dir)
      const reportsDir = path.join(__dirname, "../e2e/reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `report-a11y-auth-${encodeURIComponent(route)}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(axeResults, null, 2));
    } catch (e) {
      console.error(`[audit:a11y] ${route}: error during axe run:`, e.message);
      results.push({ route, ok: false, critical: 0, serious: 0, error: e.message });
    }
  }

  await browser.close();
  return results;
}

async function main() {
  console.log(`[audit:a11y] waiting for server on :${PORT}...`);
  await pingServer(PORT);

  const hasStorageState = fs.existsSync(STATE_PATH);
  let storageState = null;
  if (hasStorageState) {
    try {
      storageState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      console.log("[audit:a11y] storageState found — running authenticated audit (U20 real shell)");
    } catch (e) {
      console.warn("[audit:a11y] WARNING: storageState parse failed:", e.message);
    }
  }

  if (!storageState) {
    // Every route in ROUTES requires auth. Auditing them unauthenticated
    // measures the /sign-in stub and reports a false pass — that is how
    // this gate shipped "0 violations" for months while the real shell
    // was never scanned. Refuse to run instead.
    console.error(
      "[audit:a11y] No storageState at e2e/.auth-state.json — refusing to audit\n" +
      "  the /sign-in redirect stub and call it a pass.\n" +
      "  Run `node e2e/golden/seed-auth.mjs` first, then re-run audit:a11y.",
    );
    process.exit(2);
  }

  console.log("[audit:a11y] auditing live portal routes:", ROUTES.join(", "));

  let totalCritical = 0;
  let totalSerious = 0;
  let totalSeriousGateFails = 0;
  let totalErrors = 0;

  const results = await runAxeWithAuth(ROUTES, storageState);
  for (const r of results) {
    totalCritical += r.critical || 0;
    totalSerious += r.serious || 0;
    if (r.seriousGate && (r.serious || 0) > 0) totalSeriousGateFails += r.serious;
    if (r.error) totalErrors += 1;
  }

  console.log("\n[audit:a11y] === summary ===");
  console.log(
    JSON.stringify(
      {
        mode: "authenticated",
        totalCritical,
        totalSerious,
        totalSeriousGateFails,
        totalErrors,
        seriousGateRoutes: [...SERIOUS_GATE_ROUTES],
        routes: results,
      },
      null,
      2,
    ),
  );

  if (totalErrors > 0) {
    console.error(
      `[audit:a11y] FAIL: ${totalErrors} route(s) could not be audited truthfully ` +
        "(auth redirect / soft-land / run error) — a skipped route is not a passing route",
    );
    process.exit(1);
  }
  if (totalCritical > 0) {
    console.error(`[audit:a11y] FAIL: ${totalCritical} critical violations`);
    process.exit(1);
  }
  if (totalSeriousGateFails > 0) {
    console.error(
      `[audit:a11y] FAIL: ${totalSeriousGateFails} serious violations on gated routes (${[...SERIOUS_GATE_ROUTES].join(", ")})`,
    );
    process.exit(1);
  }
  console.log("[audit:a11y] PASS (no critical; serious clear on gated routes)");
}

main().catch((e) => {
  console.error("[audit:a11y] fatal:", e.message);
  process.exit(2);
});
