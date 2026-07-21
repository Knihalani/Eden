#!/usr/bin/env node
/**
 * U20 axe gate — run @axe-core/cli (unauthenticated) OR Playwright + axe-core
 * (authenticated, when e2e/.auth-state.json is present) against the running
 * portal server. Audits core routes (WCAG 2.2 AA).
 *
 * Authenticated mode (default when storageState exists):
 *   Uses Playwright with the saved Clerk storageState so pages render the real
 *   authenticated shell rather than the /sign-in redirect stub.
 *
 * Unauthenticated fallback:
 *   Falls back to @axe-core/cli when storageState is not present (e.g. first
 *   install before seed-auth has been run).
 *
 * Usage:
 *   PORT=3000 bun run audit:a11y
 *
 * CI: run seed-auth.mjs first (saves storageState), start production server,
 * then run this script. Fails on any critical violation. Also fails on
 * serious violations for /traces and /improve (W6 UX-P0-15).
 */
const { execSync, execFileSync } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = process.env.PORT || "3000";
// Keep in sync with src/lib/portal-polish.ts U20_CORE_AXE_ROUTES + IMPROVE_V3_AXE_ROUTES
const ROUTES = [
  "/dashboard",
  "/traces",
  "/issues",
  "/artifacts",
  "/playgrounds",
  "/evals",
  "/improve",
  "/alerts",
  "/agents",
  "/settings",
  // Improve V3 Wave 10 — Improve-group satellites
  "/ledger",
  "/prompts",
  "/guardrails",
  "/optimization",
];
/**
 * Keep in sync with U20_SERIOUS_AXE_ROUTES + IMPROVE_V3_SERIOUS_AXE_ROUTES —
 * fail gate on serious here.
 */
const SERIOUS_GATE_ROUTES = new Set([
  "/traces",
  "/improve",
  "/evals",
  "/issues",
  // Improve V3 Wave 10
  "/artifacts",
  "/ledger",
  "/prompts",
  "/guardrails",
  "/optimization",
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
 * Unauthenticated audit via @axe-core/cli.
 * Used as fallback when no storageState exists.
 */
function runAxeCli(url) {
  const axeBin = path.join(process.cwd(), "node_modules", ".bin", "axe");
  const reportFile = `report-${encodeURIComponent(url)}.json`;
  try {
    execSync(
      `"${axeBin}" "${url}" --exit --tags wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa --save "${reportFile}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, reportFile };
  } catch {
    return { ok: false, reportFile };
  }
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

      // Save JSON report for CI artifact
      const reportPath = path.join(process.cwd(), `report-a11y-auth-${encodeURIComponent(route)}.json`);
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
    console.warn(
      "[audit:a11y] No storageState available — running unauthenticated audit.\n" +
      "  NOTE: authenticated pages (Dashboard, Traces, etc.) will be audited as\n" +
      "  the /sign-in redirect stub, not the real authenticated shell.\n" +
      "  Run seed-auth.mjs before audit:a11y for a full U20 audit.",
    );
  }

  console.log("[audit:a11y] auditing U20 core routes:", ROUTES.join(", "));

  let totalCritical = 0;
  let totalSerious = 0;
  let totalSeriousGateFails = 0;
  let results;

  if (storageState) {
    results = await runAxeWithAuth(ROUTES, storageState);
    for (const r of results) {
      totalCritical += r.critical || 0;
      totalSerious += r.serious || 0;
      if (r.seriousGate && (r.serious || 0) > 0) totalSeriousGateFails += r.serious;
    }
  } else {
    // Unauthenticated fallback via @axe-core/cli
    results = [];
    for (const route of ROUTES) {
      const url = `http://localhost:${PORT}${route}`;
      const r = runAxeCli(url);
      const reportPath = path.join(process.cwd(), r.reportFile);
      let critical = 0;
      let serious = 0;
      const seriousGate = SERIOUS_GATE_ROUTES.has(route);

      try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        const violations = report.violations || [];
        critical = violations.filter((v) => v.impact === "critical").length;
        serious = violations.filter((v) => v.impact === "serious").length;
        totalCritical += critical;
        totalSerious += serious;
        if (seriousGate && serious > 0) totalSeriousGateFails += serious;
        console.log(
          `[audit:a11y] ${route}: ${critical} critical, ${serious} serious` +
            (seriousGate ? " (serious gated)" : ""),
        );
      } catch (e) {
        console.error(`[audit:a11y] ${route}: failed to read report`, e.message);
      }

      results.push({
        route,
        ok: r.ok && critical === 0 && (!seriousGate || serious === 0),
        critical,
        serious,
        seriousGate,
      });
    }
  }

  console.log("\n[audit:a11y] === summary ===");
  console.log(
    JSON.stringify(
      {
        mode: storageState ? "authenticated" : "unauthenticated",
        totalCritical,
        totalSerious,
        totalSeriousGateFails,
        seriousGateRoutes: [...SERIOUS_GATE_ROUTES],
        routes: results,
      },
      null,
      2,
    ),
  );

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
