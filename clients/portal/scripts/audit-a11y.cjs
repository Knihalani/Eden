#!/usr/bin/env node
/**
 * ui-audit 2026-07-06 M8: run @axe-core/cli against the running
 * portal dev server. Surfaces WCAG-A and WCAG-AA violations on
 * the most-used surfaces — surfaces that unit tests can't catch
 * (landmark gaps, label-association failures, color-contrast
 * regressions, focus-order bugs).
 *
 * Usage:
 *   PORT=3000 bun run audit:a11y
 *
 * Behavior:
 *   - Polls http://localhost:$PORT until the server responds (5s timeout).
 *   - Runs axe against /dashboard, /agents, /observability,
 *     /pr-suggestions, /settings, /billing, / (marketing).
 *   - Aggregates findings across pages; exits non-zero on any
 *     "serious" or "critical" violation.
 *   - Prints a JSON summary on stdout for CI parsing.
 *
 * Setup:
 *   The script assumes the dev server is already running on PORT.
 *   In CI, start it in a background step before running this script:
 *     bun run dev &  # wait ~10s for compile
 *     bun run audit:a11y
 */
const { execSync, spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const PORT = process.env.PORT || "3000";
const ROUTES = [
  "/",
  "/dashboard",
  "/agents",
  "/observability",
  "/pr-suggestions",
  "/settings",
  "/billing",
];
const SERIOUS = new Set(["serious", "critical"]);

function pingServer(port, timeoutMs = 30000) {
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

function runAxe(url) {
  const axeBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    "axe",
  );
  try {
    const stdout = execSync(
      `"${axeBin}" "${url}" --exit --tags wcag2a,wcag2aa,wcag21a,wcag21aa --save report-${encodeURIComponent(url)}.json`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, stdout };
  } catch (err) {
    // axe exits non-zero when violations are found. The JSON report
    // is written to disk; we read stdout for the summary.
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

async function main() {
  console.log(`[audit:a11y] waiting for dev server on :${PORT}...`);
  await pingServer(PORT);
  console.log("[audit:a11y] dev server up; running axe against", ROUTES.length, "routes");

  let totalSerious = 0;
  const results = [];
  for (const route of ROUTES) {
    const url = `http://localhost:${PORT}${route}`;
    const r = runAxe(url);
    results.push({ route, ok: r.ok });
    if (!r.ok) {
      // Count "serious"/"critical" violations in the saved JSON.
      try {
        const reportPath = path.join(
          process.cwd(),
          `report-${encodeURIComponent(url)}.json`,
        );
        const report = JSON.parse(require("node:fs").readFileSync(reportPath, "utf8"));
        const serious = (report.violations || []).filter((v) => SERIOUS.has(v.impact));
        totalSerious += serious.length;
        console.log(`[audit:a11y] ${route}: ${serious.length} serious/critical`);
      } catch (e) {
        console.error(`[audit:a11y] ${route}: failed to read report`, e.message);
      }
    } else {
      console.log(`[audit:a11y] ${route}: clean`);
    }
  }

  console.log("\n[audit:a11y] === summary ===");
  console.log(JSON.stringify({ totalSerious, routes: results }, null, 2));

  if (totalSerious > 0) {
    console.error(`[audit:a11y] FAIL: ${totalSerious} serious/critical violations`);
    process.exit(1);
  }
  console.log("[audit:a11y] PASS");
}

main().catch((e) => {
  console.error("[audit:a11y] fatal:", e.message);
  process.exit(2);
});
