#!/usr/bin/env node
/**
 * Agent 10 (portal-improve-connect) deep probe —
 * /improve /artifacts /agents /agents/connect /onboarding/improvement-loop
 * @375/@1280 with auth storageState.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent10-improve-connect");

mkdirSync(OUT, { recursive: true });

const ROUTES = [
  "/improve",
  "/artifacts",
  "/agents",
  "/agents/connect",
  "/onboarding/improvement-loop",
];

let failed = false;
function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

async function probePage(page, route, label) {
  const consoleErrors = [];
  page.removeAllListeners("console");
  page.removeAllListeners("pageerror");
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 200)));

  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2800);

  const url = page.url();
  const slug = route.replace(/\//g, "_").replace(/^_/, "") || "root";
  if (/sign-in|sign-up|login/i.test(url)) {
    fail(`[${label}] ${route} redirected to auth: ${url}`);
    await page.screenshot({ path: `${OUT}/${label}-${slug}-auth.png`, fullPage: true });
    return { route, label, url, authRedirect: true };
  }

  await page.screenshot({ path: `${OUT}/${label}-${slug}.png`, fullPage: true });

  const probe = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const html = document.documentElement.outerHTML;

    const links = [...document.querySelectorAll("a, button")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute("href") || "",
        label: (el.getAttribute("aria-label") || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    });

    const primary = links.filter((l) =>
      /docs quickstart|create api key|view (agent )?issues|link repo|connect github|skip/i.test(
        l.label,
      ),
    );

    const smallHits = primary.filter((l) => l.h > 0 && l.h < 44);

    const onboardingMisuse = [...document.querySelectorAll("a[href*='onboarding=1']")].filter(
      (a) => /install|sdk|connect|quickstart|api key|docs/i.test(a.textContent || ""),
    );

    const linkRepoPrimary = [...document.querySelectorAll("a")].some((a) => {
      const t = (a.textContent || "").toLowerCase();
      const href = a.getAttribute("href") || "";
      const cls = a.className?.toString?.() || "";
      return (
        /agents\/connect/.test(href) &&
        /link repo/.test(t) &&
        /bg-\[var\(--accent\)\]/.test(cls) &&
        !/optional/i.test(t)
      );
    });

    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent?.trim() || null,
      bodySnippet: body.slice(0, 500),
      bans: {
        onboardingMisuse: onboardingMisuse.map((a) => ({
          text: (a.textContent || "").trim().slice(0, 40),
          href: a.getAttribute("href"),
        })),
        instrumentationPr: /instrumentation\s*pr/i.test(body),
        waitForPr: /wait[- ]for[- ]pr/i.test(body),
        autoInstrument: /auto-?instrument/i.test(body),
        edenSdkWrong: /@eden\/sdk/.test(body),
        fullPrompt: /FULL_PROMPT|IMPROVE_LOG/.test(body),
        linkRepoPrimary,
      },
      hasDocsQs: primary.some((p) => /docs quickstart/i.test(p.label)),
      hasApiKey: primary.some((p) => /create api key|api keys/i.test(p.label)),
      hasOptionalConnect: /optional/i.test(body) && /agents\/connect|link repo|connect a repository/i.test(html),
      duplicateConnectHero:
        [...document.querySelectorAll("h1, h2")].filter((h) =>
          /connect a repository|link a github repository/i.test(h.textContent || ""),
        ).length > 1,
      primary,
      smallHits,
    };
  });

  if (probe.bans.onboardingMisuse.length) {
    fail(`[${label}] ${route}: Install/docs CTA uses ?onboarding=1 ${JSON.stringify(probe.bans.onboardingMisuse)}`);
  }
  if (probe.bans.instrumentationPr) fail(`[${label}] ${route}: instrumentation PR language`);
  if (probe.bans.waitForPr) fail(`[${label}] ${route}: wait-for-PR language`);
  if (probe.bans.autoInstrument) fail(`[${label}] ${route}: auto-instrument language`);
  if (probe.bans.edenSdkWrong) fail(`[${label}] ${route}: @eden/sdk ban`);
  if (probe.bans.fullPrompt) fail(`[${label}] ${route}: FULL_PROMPT ban`);
  if (probe.bans.linkRepoPrimary && route === "/agents") {
    fail(`[${label}] ${route}: Link repo is primary accent CTA (should be secondary)`);
  }
  if (route === "/agents/connect" && probe.duplicateConnectHero) {
    fail(`[${label}] ${route}: duplicate Connect hero titles`);
  }

  if (route === "/improve" || route === "/artifacts") {
    if (/nothing in the queue|no artifacts yet/i.test(probe.bodySnippet || "")) {
      if (!probe.hasDocsQs) fail(`[${label}] ${route} empty missing Docs quickstart`);
      if (!probe.hasApiKey) fail(`[${label}] ${route} empty missing Create API key`);
    }
  }

  if (probe.smallHits.length) {
    fail(`[${label}] ${route} primary CTAs <44px: ${JSON.stringify(probe.smallHits)}`);
  } else {
    console.log(`[${label}] ${route} primary hit targets OK (${probe.primary.length} checked)`);
  }

  if (consoleErrors.length) {
    console.warn(`[${label}] ${route} console errors:`, consoleErrors.slice(0, 3));
  }

  console.log(`[${label}] ${route}`, {
    h1: probe.h1,
    bans: probe.bans,
    ctas: probe.primary.map((c) => `${c.label}@${c.h}px`),
    consoleErrors: consoleErrors.length,
  });

  return {
    route,
    label,
    url,
    ...probe,
    consoleErrors: consoleErrors.slice(0, 8),
  };
}

async function runViewport(browser, width, height, label) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const all = [];
  for (const route of ROUTES) {
    all.push(await probePage(page, route, label));
  }
  // Keyboard smoke on /improve
  await page.goto(`${BASE}/improve`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  const focusTag = await page.evaluate(() => document.activeElement?.tagName);
  console.log(`[${label}] keyboard focus after Tab×6:`, focusTag);
  await ctx.close();
  return all;
}

async function main() {
  if (!existsSync(STATE)) {
    fail(`missing auth state: ${STATE}`);
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const results = [];
  results.push(...(await runViewport(browser, 375, 812, "375")));
  results.push(...(await runViewport(browser, 1280, 800, "1280")));
  await browser.close();

  writeFileSync(resolve(OUT, "probe-results.json"), JSON.stringify(results, null, 2));
  console.log(failed ? "\nAgent 10 probe: FAIL" : "\nAgent 10 probe: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
