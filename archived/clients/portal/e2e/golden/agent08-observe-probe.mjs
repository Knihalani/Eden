#!/usr/bin/env node
/**
 * Agent 08 (portal-observe) deep probe — /traces /issues /alerts @375/@1280.
 * Uses e2e/.auth-state.json. API cold / empty is OK (honest empty/error).
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent08-observe");

mkdirSync(OUT, { recursive: true });

const ROUTES = ["/traces", "/issues", "/alerts"];
let failed = false;
function fail(msg) {
  console.error("FAIL:", msg);
  failed = true;
}

async function probePage(page, route, label) {
  const findings = {
    route,
    label,
    url: "",
    title: "",
    emptyTitle: null,
    bans: {},
    ctas: [],
    smallHits: [],
    terminalGreen: 0,
    consoleErrors: [],
  };

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err.message).slice(0, 200)));

  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2800);

  findings.url = page.url();
  if (/sign-in|sign-up|login/i.test(findings.url)) {
    fail(`[${label}] ${route} redirected to auth: ${findings.url}`);
    await page.screenshot({ path: `${OUT}/${label}-${route.slice(1)}-auth.png`, fullPage: true });
    return findings;
  }

  await page.screenshot({ path: `${OUT}/${label}-${route.slice(1)}.png`, fullPage: true });

  const probe = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const emptyTitle =
      document.querySelector('[data-testid="traces-first-run-hint"] h2, [data-testid="traces-first-run-hint"] h3')?.textContent ||
      [...document.querySelectorAll("h2, h3")].find((h) =>
        /no (traces|issues|alert)|all clear/i.test(h.textContent || ""),
      )?.textContent ||
      null;

    const links = [...document.querySelectorAll("a, button")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute("href") || "",
        label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    });

    const primary = links.filter((l) =>
      /api keys|docs quickstart|install sdk|create rule|clear filters/i.test(l.label),
    );

    const smallHits = primary.filter((l) => l.h > 0 && l.h < 44);

    const bans = {
      onboarding: /[?&]onboarding=1/.test(document.documentElement.outerHTML) &&
        [...document.querySelectorAll("a[href*='onboarding=1']")].some((a) =>
          /install|sdk|connect|quickstart|api key/i.test(a.textContent || ""),
        ),
      connectAsSetup: [...document.querySelectorAll("a")].some((a) => {
        const t = (a.textContent || "").toLowerCase();
        const href = a.getAttribute("href") || "";
        return /agents\/connect/.test(href) && /install|setup|first trace|get started|sdk/i.test(t);
      }),
      allClearNoRules:
        /all clear/i.test(body) &&
        !/create rule|rules/i.test(body) === false
          ? /all clear/i.test(
              [...document.querySelectorAll("h2, h3")].map((h) => h.textContent).join(" "),
            ) &&
            !document.querySelector('[data-testid="alerts-create-rule-cta"]') &&
            /no alert rules yet/i.test(body) === false &&
            body.includes("All clear")
          : false,
      edenSdkWrong: /@eden\/sdk/.test(body),
      fullPrompt: /FULL_PROMPT|IMPROVE_LOG/.test(body),
    };

    // Decorative phosphor: --terminal used when not live/ok
    const terminalEls = [...document.querySelectorAll("*")].filter((el) => {
      const cls = el.className?.toString?.() || "";
      return /text-\[var\(--terminal\)\]|bg-\[var\(--terminal\)\]/.test(cls);
    });

    return {
      title: document.title,
      emptyTitle,
      bodySnippet: body.slice(0, 400),
      bans: {
        ...bans,
        allClearVisible: /All clear/i.test(
          [...document.querySelectorAll("h2, h3")].map((h) => h.textContent || "").join("|"),
        ),
        noRulesYet: /No alert rules yet/i.test(body),
        createRuleCta: Boolean(document.querySelector('[data-testid="alerts-create-rule-cta"]')),
        tracesHint: Boolean(document.querySelector('[data-testid="traces-first-run-hint"]')),
        installSdk: primary.some((p) => /install sdk/i.test(p.label)),
        apiKeys: primary.some((p) => /api keys/i.test(p.label)),
        docsQs: primary.some((p) => /docs quickstart/i.test(p.label)),
      },
      primary,
      smallHits,
      terminalGreen: terminalEls.length,
      terminalSample: terminalEls.slice(0, 3).map((el) => (el.textContent || "").trim().slice(0, 40)),
    };
  });

  findings.title = probe.title;
  findings.emptyTitle = probe.emptyTitle;
  findings.bans = probe.bans;
  findings.ctas = probe.primary;
  findings.smallHits = probe.smallHits;
  findings.terminalGreen = probe.terminalGreen;
  findings.consoleErrors = consoleErrors.slice(0, 8);

  if (probe.bans.onboarding) fail(`[${label}] ${route}: Install/setup CTA uses ?onboarding=1`);
  if (probe.bans.connectAsSetup) fail(`[${label}] ${route}: Connect framed as setup`);
  if (probe.bans.edenSdkWrong) fail(`[${label}] ${route}: @eden/sdk ban`);
  if (probe.bans.fullPrompt) fail(`[${label}] ${route}: FULL_PROMPT ban`);

  if (route === "/traces") {
    if (!probe.bans.tracesHint && !/no traces/i.test(probe.bodySnippet)) {
      // empty or list — either OK when API has data
      console.log(`[${label}] /traces: no empty hint (may have data)`);
    } else {
      if (!probe.bans.apiKeys) fail(`[${label}] /traces empty missing API keys CTA`);
      if (!probe.bans.docsQs) fail(`[${label}] /traces empty missing Docs quickstart CTA`);
    }
  }
  if (route === "/issues") {
    if (/no issues/i.test(probe.bodySnippet || "") || probe.emptyTitle) {
      if (!probe.bans.installSdk) fail(`[${label}] /issues empty missing Install SDK`);
      if (!probe.bans.apiKeys) fail(`[${label}] /issues empty missing API keys`);
      if (probe.bans.onboarding) fail(`[${label}] /issues onboarding ban`);
    }
  }
  if (route === "/alerts") {
    if (probe.bans.allClearVisible && probe.bans.createRuleCta) {
      fail(`[${label}] /alerts: All clear shown with Create rule (no rules)`);
    }
    if (probe.bans.noRulesYet && !probe.bans.createRuleCta) {
      fail(`[${label}] /alerts: No alert rules yet without Create rule CTA`);
    }
    if (probe.bans.allClearVisible && !probe.bans.noRulesYet && probe.bans.createRuleCta) {
      fail(`[${label}] /alerts: All clear + Create rule inconsistency`);
    }
  }

  if (probe.smallHits.length) {
    fail(`[${label}] ${route} primary CTAs <44px: ${JSON.stringify(probe.smallHits)}`);
  } else {
    console.log(`[${label}] ${route} primary hit targets OK`);
  }

  // Live tail green only when connected is checked via LiveTail text, not count
  if (route === "/traces") {
    const live = await page.evaluate(() => {
      const section = document.querySelector('[aria-label="Live trace tail"]');
      if (!section) return null;
      const status = section.querySelector("p.text-\\[10px\\], p")?.textContent || "";
      const green = [...section.querySelectorAll("*")].some((el) =>
        /text-\[var\(--terminal\)\]/.test(el.className?.toString?.() || ""),
      );
      return { status, green };
    });
    if (live?.green && /connecting|waiting|lost|paused/i.test(live.status) && !/streaming/i.test(live.status)) {
      // green while connecting is OK only if connected; connecting shouldn't be green
      if (/connecting/i.test(live.status) && live.green) {
        fail(`[${label}] LiveTail --terminal green while Connecting`);
      }
    }
    console.log(`[${label}] LiveTail:`, live);
  }

  console.log(`[${label}] ${route}`, {
    emptyTitle: findings.emptyTitle,
    bans: findings.bans,
    ctas: findings.ctas.map((c) => `${c.label}@${c.h}px`),
    consoleErrors: findings.consoleErrors.length,
  });

  return findings;
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
  // Keyboard: Tab reaches Create rule / Install on alerts then issues
  await page.goto(`${BASE}/alerts`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focusTag = await page.evaluate(() => document.activeElement?.tagName);
  console.log(`[${label}] keyboard focus after Tab:`, focusTag);
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
  console.log(failed ? "\nAgent 08 probe: FAIL" : "\nAgent 08 probe: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
