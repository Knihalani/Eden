#!/usr/bin/env node
/**
 * W6 visual smoke checklist — chrome + key hubs.
 *
 * Default (no browser): prints expected routes/screenshots and whether
 * baseline PNGs exist under e2e/golden/screenshots/.
 *
 * Capture (requires portal + Clerk auth):
 *   VISUAL_SMOKE_CAPTURE=1 node e2e/golden/w6-visual-smoke-checklist.mjs
 *
 * Auth: e2e/.auth-state.json from seed-auth.mjs (local) or wait-for-signin.mjs.
 * See e2e/README-auth.md and docs/specs/ui/overhaul-2026/w6-visual-regression.md.
 *
 * Does not delete existing evidence. Capture writes under
 * e2e/golden/screenshots/w6-visual-smoke/ (additive).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { BASE, loadAuthState, assertNoCrash, screenshotStep } from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL_ROOT = resolve(__dirname, "../..");
loadEnv({ path: resolve(PORTAL_ROOT, ".env.local") });
loadEnv({ path: resolve(PORTAL_ROOT, ".env") });

const CAPTURE = process.env.VISUAL_SMOKE_CAPTURE === "1";
const SCREENSHOT_ROOT = resolve(PORTAL_ROOT, "e2e/golden/screenshots");
const W6_OUT = resolve(SCREENSHOT_ROOT, "w6-visual-smoke");

/**
 * Key hubs for Wave 6 chrome + surface visual regression.
 * `f85Id` links to golden-paths.spec.mjs when covered there.
 */
export const W6_VISUAL_TARGETS = [
  {
    id: "w6-dashboard",
    route: "/dashboard",
    label: "Home / Dashboard (chrome + first-run)",
    f85Id: "01-sign-in-home",
    baselinePngs: ["01-sign-in-home.png", "agent07-portal-home/desktop-1280.png"],
    chromeFocus: ["sidebar", "PageHeader", "AppShell", "MobileBottomNav"],
  },
  {
    id: "w6-traces",
    route: "/traces",
    label: "Traces hub (≤2 bands)",
    f85Id: "02-traces-hub",
    baselinePngs: ["02-traces-hub.png", "w2-traces-list-200-proof.png"],
    chromeFocus: ["ResourcePageShell", "QueryFilterBar", "ViewsMenu", "sidebar"],
  },
  {
    id: "w6-issues",
    route: "/issues",
    label: "Issues list",
    f85Id: "03-issues",
    baselinePngs: ["03-issues.png"],
    chromeFocus: ["PageHeader", "CoreResourcePage", "sidebar"],
  },
  {
    id: "w6-alerts",
    route: "/alerts",
    label: "Alerts hub",
    f85Id: "06-alerts",
    baselinePngs: ["06-alerts.png"],
    chromeFocus: ["PageHeader", "toolbar", "sidebar"],
  },
  {
    id: "w6-agents",
    route: "/agents",
    label: "Agents hub",
    f85Id: null,
    baselinePngs: [],
    chromeFocus: ["PageHeader", "CoreResourcePage", "sidebar", "fleet tab"],
    gap: "No F85 golden path; agent10 probe exists but screenshot dir empty",
  },
  {
    id: "w6-improve",
    route: "/improve",
    label: "Improve hub",
    f85Id: null,
    baselinePngs: [],
    chromeFocus: ["PageHeader", "board chrome", "sidebar"],
    gap: "No F85 golden path; agent10 probe covers route without PNG baseline",
  },
  {
    id: "w6-settings",
    route: "/settings",
    label: "Settings (identity chrome)",
    f85Id: null,
    baselinePngs: [],
    chromeFocus: ["settings rail", "PageHeader", "org switcher", "sidebar"],
    gap: "Only indirect via tour CTA → /settings?tab=api-keys; no hub PNG",
  },
];

function pngExists(rel) {
  return existsSync(resolve(SCREENSHOT_ROOT, rel));
}

function printChecklist() {
  console.log(`# W6 visual smoke checklist`);
  console.log(`BASE=${BASE}`);
  console.log(`screenshots root: ${SCREENSHOT_ROOT}`);
  console.log(`capture mode: ${CAPTURE ? "ON" : "OFF (docs-only inventory)"}\n`);

  const rows = [];
  for (const t of W6_VISUAL_TARGETS) {
    const existing = (t.baselinePngs || []).filter(pngExists);
    const missingBaselines = (t.baselinePngs || []).filter((p) => !pngExists(p));
    const status =
      existing.length > 0
        ? "HAS_BASELINE"
        : t.gap
          ? "GAP"
          : "NO_BASELINE";
    rows.push({ ...t, existing, missingBaselines, status });

    console.log(`## ${t.id} — ${t.label}`);
    console.log(`  route: ${t.route}`);
    console.log(`  F85: ${t.f85Id || "(none)"}`);
    console.log(`  status: ${status}`);
    console.log(`  chrome focus: ${t.chromeFocus.join(", ")}`);
    if (existing.length) console.log(`  existing PNGs: ${existing.join(", ")}`);
    if (missingBaselines.length) console.log(`  missing listed PNGs: ${missingBaselines.join(", ")}`);
    if (t.gap) console.log(`  gap: ${t.gap}`);
    console.log("");
  }

  const gaps = rows.filter((r) => r.status === "GAP" || r.status === "NO_BASELINE");
  console.log(`Summary: ${rows.length} targets, ${gaps.length} without usable PNG baseline.`);
  console.log(`Re-baseline F85: node e2e/golden/seed-auth.mjs && GOLDEN_CI=1 node e2e/golden/golden-paths.spec.mjs`);
  console.log(`Capture W6 additive set: VISUAL_SMOKE_CAPTURE=1 node e2e/golden/w6-visual-smoke-checklist.mjs`);

  return rows;
}

async function captureTargets(rows) {
  const auth = loadAuthState();
  if (!auth) {
    console.error("[w6-visual] FATAL: capture requires e2e/.auth-state.json");
    process.exit(1);
  }

  mkdirSync(W6_OUT, { recursive: true });
  process.env.GOLDEN_SCREENSHOT_DIR = W6_OUT;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: auth,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const results = [];

  for (const t of rows) {
    const entry = { id: t.id, route: t.route, ok: false, error: null, png: `${t.id}.png` };
    try {
      await page.goto(`${BASE}${t.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(1500);
      await assertNoCrash(page);
      await screenshotStep(page, t.id);
      entry.ok = true;
      console.log(`[w6-visual] captured ${t.id} → w6-visual-smoke/${t.id}.png`);
    } catch (e) {
      entry.error = String(e).slice(0, 240);
      console.error(`[w6-visual] FAIL ${t.id}: ${entry.error}`);
      await screenshotStep(page, `${t.id}-fail`).catch(() => {});
    }
    results.push(entry);
  }

  await browser.close();

  const summaryPath = resolve(W6_OUT, "summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`[w6-visual] wrote ${summaryPath}`);

  const failed = results.filter((r) => !r.ok).length;
  if (failed) {
    console.error(`[w6-visual] ${failed}/${results.length} captures failed`);
    process.exit(1);
  }
}

const inventory = printChecklist();
if (CAPTURE) {
  await captureTargets(inventory);
}
