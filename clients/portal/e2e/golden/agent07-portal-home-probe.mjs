#!/usr/bin/env node
/**
 * Agent 07 (portal-home) deep probe — /dashboard @375/@1280.
 * Uses e2e/.auth-state.json. Distinguishes empty vs API-error.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent07-portal-home");

mkdirSync(OUT, { recursive: true });

let failed = false;
function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

async function probe(page, label, width) {
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 200)));

  await page.setViewportSize({ width, height: width < 500 ? 812 : 900 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);

  const url = page.url();
  if (/sign-in|sign-up|login/i.test(url)) {
    fail(`[${label}] redirected to auth: ${url}`);
    await page.screenshot({ path: `${OUT}/${label}-auth.png`, fullPage: true });
    return { label, url, authRedirect: true };
  }

  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });

  const data = await page.evaluate(() => {
    const root = document.querySelector("[data-testid='dashboard-first-run']");
    const body = document.body?.innerText || "";
    const hrefs = [...document.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href") || "",
      label: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    }));

    const actionOrder = [];
    for (const a of document.querySelectorAll("main a, main button")) {
      const t = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (
        /^(API keys|Docs quickstart|Product tour|Connect a repo)$/i.test(t) &&
        !actionOrder.includes(t)
      ) {
        actionOrder.push(t);
      }
    }

    const checklist = [...document.querySelectorAll("[data-testid='dashboard-first-run'] li")].map(
      (li) => (li.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
    );

    const connectHrefs = hrefs
      .filter((h) => /agents\/connect/.test(h.href))
      .map((h) => h.href);

    const primary = [...document.querySelectorAll("a, button")].map((el) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      return {
        label,
        href: el.getAttribute("href") || "",
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    });

    const firstRunPrimaries = primary.filter((p) => {
      if (
        !/^(API keys|Docs quickstart|Product tour|Connect a repo|Create API key|Open Traces)$/i.test(
          p.label,
        )
      ) {
        return false;
      }
      if (p.label === "API keys" && p.w > 180) return false;
      return true;
    });
    const smallHits = firstRunPrimaries.filter((p) => p.h > 0 && p.h < 44);

    return {
      title: document.title,
      bodyHas: {
        getStarted: Boolean(root) || /Get started with observability/i.test(body),
        createKey: /Create API key/i.test(body),
        installSdk: /Install SDK|Install the SDK/i.test(body),
        doctor: /Run doctor|eden-doctor/i.test(body),
        openTraces: /Open Traces/i.test(body),
        sdkSubtitle: /Install the SDK or gateway/i.test(body),
        unavailable: /Traces unavailable|Could not load some telemetry/i.test(body),
        noTracesYet: /No traces yet/i.test(body),
        editLayout: /Edit layout/i.test(body),
      },
      checklist,
      actionOrder,
      connectHrefs,
      connectHasOnboarding: connectHrefs.some((h) => /onboarding=1/.test(h)),
      smallHits,
      firstRunPrimaries: firstRunPrimaries.slice(0, 12),
      bans: {
        edenSdkWrong: /@eden\/sdk/.test(body),
        fullPrompt: /FULL_PROMPT|IMPROVE_LOG/.test(body),
      },
      bodySnippet: body.slice(0, 600),
    };
  });

  data.consoleErrors = consoleErrors.slice(0, 8);
  data.url = url;
  data.label = label;
  data.width = width;

  // Assertions — install-forward first-run must win over Connect-primary
  if (data.bans.edenSdkWrong) fail(`[${label}] @eden/sdk ban`);
  if (data.bans.fullPrompt) fail(`[${label}] FULL_PROMPT ban`);
  if (data.connectHasOnboarding) fail(`[${label}] Connect → ?onboarding=1`);
  if (!data.bodyHas.getStarted) {
    fail(`[${label}] missing first-run checklist (API cold should still show install path)`);
  } else {
    const expected = ["API keys", "Docs quickstart", "Product tour"];
    const got = data.actionOrder;
    let idx = -1;
    for (const step of expected) {
      const at = got.indexOf(step);
      if (at === -1) fail(`[${label}] missing header action "${step}" (got ${JSON.stringify(got)})`);
      else if (at < idx) fail(`[${label}] button order wrong: ${JSON.stringify(got)}`);
      else idx = at;
    }
    if (got.includes("Connect a repo")) {
      const c = got.indexOf("Connect a repo");
      const t = got.indexOf("Product tour");
      if (t >= 0 && c < t) fail(`[${label}] Connect before Product tour`);
    }
    if (!data.bodyHas.doctor) fail(`[${label}] checklist missing Doctor`);
    if (!data.bodyHas.openTraces) fail(`[${label}] checklist missing Open Traces`);
    if (!data.bodyHas.installSdk) fail(`[${label}] checklist missing Install SDK`);
    if (data.bodyHas.editLayout) fail(`[${label}] Edit layout theatre on first-run`);
  }
  if (data.bodyHas.unavailable && data.bodyHas.getStarted) {
    fail(`[${label}] first-run + API-unavailable simultaneously`);
  }
  if (data.smallHits.length) {
    fail(
      `[${label}] primary hit targets <44px: ${data.smallHits.map((s) => `${s.label}@${s.h}`).join(", ")}`,
    );
  }
  const p0Console = data.consoleErrors.filter(
    (e) =>
      !/ResizeObserver|hydration|favicon|Clerk|502|503|Bad Gateway|Service Unavailable|nested %s|Maximum update depth|trouble reaching the server/i.test(
        e,
      ),
  );
  if (p0Console.length) {
    console.warn(`[${label}] console:`, p0Console);
  }

  writeFileSync(`${OUT}/${label}.json`, JSON.stringify(data, null, 2));
  console.log(`[${label}] ok url=${url}`);
  console.log(`  first-run=${data.bodyHas.getStarted} unavailable=${data.bodyHas.unavailable} empty=${data.bodyHas.noTracesYet}`);
  console.log(`  actions=${JSON.stringify(data.actionOrder)}`);
  console.log(`  checklist=${JSON.stringify(data.checklist.slice(0, 6))}`);
  return data;
}

async function main() {
  if (!existsSync(STATE)) {
    console.error("Missing auth state:", STATE);
    process.exit(2);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STATE });
  const page = await context.newPage();

  const results = [];
  results.push(await probe(page, "mobile-375", 375));
  results.push(await probe(page, "desktop-1280", 1280));

  writeFileSync(`${OUT}/summary.json`, JSON.stringify({ BASE, results, failed }, null, 2));
  await browser.close();
  console.log(failed ? "AGENT07 FAIL" : "AGENT07 PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
