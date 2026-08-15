#!/usr/bin/env node
/**
 * Agent 11 probe — Phase 7 golden observe → eval → improve + Settings/Audit.
 * Uses e2e/.auth-state.json. Soft skip when missing.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent11-phase7");
const DRY =
  process.env.E6_PROBE_DRY === "1" ||
  process.env.E6_PROBE_DRY === "true" ||
  !existsSync(STATE);

const ROUTES = [
  { path: "/traces", label: "traces" },
  { path: "/evals", label: "evals" },
  { path: "/improve", label: "improve" },
  { path: "/settings", label: "settings" },
  { path: "/settings?tab=gateway", label: "settings-gateway" },
  { path: "/settings?tab=api-keys", label: "settings-keys" },
  { path: "/audit", label: "audit" },
  { path: "/audit?tab=packs", label: "audit-packs" },
  { path: "/agent", label: "agent" },
  { path: "/debugger", label: "debugger" },
];

if (DRY) {
  const reason =
    process.env.E6_PROBE_DRY === "1" || process.env.E6_PROBE_DRY === "true"
      ? "E6_PROBE_DRY=1"
      : `missing auth state: ${STATE}`;
  console.log(`SKIP: agent11 phase7 probe soft-skip (${reason})`);
  console.log(
    "Routes when live: /traces → /evals → /improve, /settings, /audit, /agent, /debugger",
  );
  console.log("RESULT: SKIP (exit 0)");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright");

let failed = false;
function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

async function gotoAuthed(page, path, label) {
  const target = `${BASE}${path}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(attempt === 1 ? 1500 : 2800);
    const url = page.url();
    if (!/sign-in|sign-up|login/i.test(url)) return url;
    if (attempt === 1) console.log(`[${label}] ${path} auth warm-up retry…`);
  }
  return page.url();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: STATE,
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();

for (const route of ROUTES) {
  const url = await gotoAuthed(page, route.path, route.label);
  if (/sign-in|sign-up|login/i.test(url)) {
    fail(`${route.label}: still on auth (${url})`);
    continue;
  }
  if (url.includes("/dashboard") && !route.path.includes("dashboard")) {
    // Soft-land would send here — fail for must-ship
    if (
      ["/settings", "/audit", "/agent", "/debugger", "/traces", "/evals", "/improve"].some(
        (p) => route.path.startsWith(p),
      )
    ) {
      fail(`${route.label}: soft-landed to dashboard (${url})`);
    }
  }
  const body = await page.locator("main").innerText().catch(() => "");
  if (/coming soon/i.test(body)) {
    fail(`${route.label}: still Coming soon`);
  }
  console.log(`OK: ${route.label} → ${url}`);
  await page.screenshot({
    path: resolve(OUT, `${route.label}.png`),
    fullPage: false,
  });
}

await browser.close();

if (failed) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
process.exit(0);
