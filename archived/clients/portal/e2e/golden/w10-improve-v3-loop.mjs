#!/usr/bin/env node
/**
 * Improve V3 Wave 10 — Improve-group loop smoke (Playwright).
 *
 * Extends the Observe→Eval→Improve contract from w12-observe-eval-improve.mjs
 * with the V3 Improve core path: Queue → Artifacts → Ledger → Prompts (optional).
 *
 * Default (no browser): prints the route contract and exits 0.
 * Live run (requires portal + Clerk auth):
 *   W10_IMPROVE_E2E_LIVE=1 node e2e/golden/w10-improve-v3-loop.mjs
 *   # also accepted:
 *   W12_E2E_LIVE=1 / W_V3_E2E_LIVE=1
 *
 * Auth: e2e/.auth-state.json from seed-auth.mjs.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(__dirname, "../..");
loadEnv({ path: resolve(PORTAL_ROOT, ".env.local") });
loadEnv({ path: resolve(PORTAL_ROOT, ".env") });

const LIVE =
  process.env.W10_IMPROVE_E2E_LIVE === "1" ||
  process.env.W12_E2E_LIVE === "1" ||
  process.env.W_V3_E2E_LIVE === "1";

/** Include Prompts hop unless W10_IMPROVE_SKIP_PROMPTS=1. */
const INCLUDE_PROMPTS = process.env.W10_IMPROVE_SKIP_PROMPTS !== "1";

/**
 * Improve V3 act loop — Queue → evidence → memory → (optional) Prompts.
 * Parent Observe→Eval→Improve still lives in w12-observe-eval-improve.mjs.
 */
export const W10_IMPROVE_V3_LOOP = [
  {
    id: "queue",
    route: "/improve",
    label: "Improve · Queue",
    expect: /Improve|Queue|Needs you|empty|No /i,
    marker: 'data-wave10-improve-verify="completed"',
  },
  {
    id: "artifacts",
    route: "/artifacts",
    label: "Improve · Artifacts",
    expect: /Artifact|Promote|shadow|empty|No /i,
  },
  {
    id: "ledger",
    route: "/ledger",
    label: "Improve · Ledger",
    expect: /Ledger|Promotion|draft|empty|No /i,
  },
  {
    id: "prompts",
    route: "/prompts",
    label: "Improve · Prompts (optional hop)",
    expect: /Prompt|draft|Publish|empty|No /i,
    optional: true,
  },
];

function activeLoop() {
  return W10_IMPROVE_V3_LOOP.filter((s) => !s.optional || INCLUDE_PROMPTS);
}

function printContract() {
  console.log("Improve V3 Wave 10 E2E loop contract (Queue → Artifacts → Ledger → Prompts)\n");
  for (const step of activeLoop()) {
    const opt = step.optional ? " (optional)" : "";
    console.log(`  ${step.id.padEnd(10)} ${step.route.padEnd(14)} ${step.label}${opt}`);
  }
  console.log("\nParent Observe→Eval→Improve: e2e/golden/w12-observe-eval-improve.mjs");
  console.log("Marker: data-wave10-improve-verify=\"completed\" on /improve toolbar");
  console.log(
    "\nDry-run OK. Set W10_IMPROVE_E2E_LIVE=1 with e2e/.auth-state.json to execute.",
  );
}

async function runLive() {
  const { chromium } = await import("playwright");
  const { BASE, loadAuthState, assertNoCrash, assertAuthShell } = await import(
    "./helpers.mjs"
  );

  const authPath = resolve(PORTAL_ROOT, "e2e/.auth-state.json");
  if (!existsSync(authPath)) {
    console.error("Missing e2e/.auth-state.json — run seed-auth first.");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: await loadAuthState() });
  const page = await context.newPage();
  const failures = [];

  try {
    for (const step of activeLoop()) {
      const url = `${BASE}${step.route}`;
      console.log(`→ ${step.label} (${url})`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCrash(page);
      await assertAuthShell(page);
      const body = await page.locator("body").innerText().catch(() => "");
      if (!step.expect.test(body)) {
        failures.push(`${step.id}: body did not match ${step.expect}`);
      } else {
        console.log(`  ✓ ${step.id}`);
      }
      if (step.marker) {
        const found = await page.locator(`[${step.marker}]`).count();
        if (found < 1) {
          failures.push(`${step.id}: missing marker ${step.marker}`);
        } else {
          console.log(`  ✓ marker ${step.marker}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error("W10 Improve V3 E2E failures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("W10 Improve V3 loop live smoke OK");
}

if (LIVE) {
  runLive().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  printContract();
}
