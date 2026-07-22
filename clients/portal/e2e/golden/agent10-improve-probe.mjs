#!/usr/bin/env node
/**
 * Agent 10 probe — Issue → Improve handoff + Improve/Cost/Guardrails hubs @375/@1280.
 * Uses e2e/.auth-state.json. API cold / empty is OK.
 *
 * Soft skip (exit 0): E6_PROBE_DRY=1 or missing e2e/.auth-state.json
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent10-improve");
const DRY =
  process.env.E6_PROBE_DRY === "1" ||
  process.env.E6_PROBE_DRY === "true" ||
  !existsSync(STATE);

const ROUTES = [
  { path: "/issues", testId: "issues-page", label: "issues" },
  {
    path: "/improve?tab=plans&issueId=probe-issue",
    testId: "improve-hub",
    label: "improve-from-issue",
  },
  { path: "/improve", testId: "improve-hub", label: "improve" },
  { path: "/cost", testId: "cost-hub", label: "cost" },
  { path: "/guardrails", testId: "guardrails-hub", label: "guardrails" },
];

if (DRY) {
  const reason =
    process.env.E6_PROBE_DRY === "1" || process.env.E6_PROBE_DRY === "true"
      ? "E6_PROBE_DRY=1"
      : `missing auth state: ${STATE}`;
  console.log(`SKIP: agent10 improve probe soft-skip (${reason})`);
  console.log("Debt: live hub @375/@1280 needs e2e/.auth-state.json + portal.");
  console.log(
    "Routes when live: /issues, /improve?tab=plans&issueId=…, /improve, /cost, /guardrails",
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

async function probe(page, route, tag) {
  const findings = {
    route: route.path,
    label: tag,
    url: "",
    hasShell: false,
    tabs: [],
    bans: {},
  };

  findings.url = await gotoAuthed(page, route.path, tag);
  if (/sign-in|sign-up|login/i.test(findings.url)) {
    fail(`[${tag}] ${route.path} redirected to auth: ${findings.url}`);
    await page.screenshot({
      path: `${OUT}/${tag}-${route.label}-auth.png`,
      fullPage: true,
    });
    return findings;
  }

  await page.waitForTimeout(1000);
  await page.screenshot({
    path: `${OUT}/${tag}-${route.label}.png`,
    fullPage: true,
  });

  const probeData = await page.evaluate((expectedTestId) => {
    const html = document.documentElement.outerHTML;
    const shell = document.querySelector(`[data-testid="${expectedTestId}"]`);
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => ({
      label: (t.textContent || "").trim(),
      selected: t.getAttribute("aria-selected") === "true",
      h: Math.round(t.getBoundingClientRect().height),
    }));
    return {
      hasShell: Boolean(shell),
      tabs,
      bans: {
        embeddedSurface: /EmbeddedSurface|useEmbeddedSurface/.test(html),
        stubImprove: /\/_stub\/improve/.test(html),
        stubCost: /\/_stub\/cost/.test(html),
        stubGuardrails: /\/_stub\/guardrails/.test(html),
        redteam: /\/redteam/.test(html),
      },
    };
  }, route.testId);

  findings.hasShell = probeData.hasShell;
  findings.tabs = probeData.tabs;
  findings.bans = probeData.bans;

  if (!probeData.hasShell) {
    fail(`[${tag}] ${route.path}: missing data-testid="${route.testId}"`);
  }
  if (probeData.bans.embeddedSurface) {
    fail(`[${tag}] ${route.path}: EmbeddedSurface ban`);
  }
  if (probeData.bans.stubImprove) {
    fail(`[${tag}] ${route.path}: /_stub/improve still present`);
  }
  if (probeData.bans.stubCost) {
    fail(`[${tag}] ${route.path}: /_stub/cost still present`);
  }
  if (probeData.bans.stubGuardrails) {
    fail(`[${tag}] ${route.path}: /_stub/guardrails still present`);
  }
  if (probeData.bans.redteam) {
    fail(`[${tag}] ${route.path}: redteam ban`);
  }

  if (route.label === "improve-from-issue") {
    const u = new URL(findings.url);
    if (u.searchParams.get("tab") !== "plans") {
      fail(`[${tag}] expected tab=plans on handoff URL, got ${u.search}`);
    }
    if (u.searchParams.get("issueId") !== "probe-issue") {
      fail(`[${tag}] expected issueId=probe-issue on handoff URL, got ${u.search}`);
    }
  }

  const smallTabs = (probeData.tabs || []).filter((t) => t.h > 0 && t.h < 44);
  if (smallTabs.length) {
    fail(`[${tag}] tab hit targets <44px: ${JSON.stringify(smallTabs)}`);
  }

  console.log(`[${tag}] ${route.path}`, {
    hasShell: findings.hasShell,
    tabs: findings.tabs.map((t) => t.label),
  });
  return findings;
}

async function runViewport(browser, width, height, tag) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const results = [];
  for (const route of ROUTES) {
    results.push(await probe(page, route, tag));
  }
  await ctx.close();
  return results;
}

const browser = await chromium.launch({ headless: true });
try {
  const all = [];
  all.push(...(await runViewport(browser, 375, 812, "375")));
  all.push(...(await runViewport(browser, 1280, 800, "1280")));
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify(all, null, 2));
  console.log(`\nEvidence → ${OUT}/evidence.json`);
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
