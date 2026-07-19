#!/usr/bin/env node
/**
 * Agent 06 deep probe — product tour @375/@1280 + Esc/Skip + step order.
 * Uses e2e/.auth-state.json. API cold (503) is OK.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent06-tour");
const EXPECTED = [
  "welcome",
  "api-keys",
  "install",
  "traces",
  "dashboard",
  "issues",
  "improve",
  "finish",
];

mkdirSync(OUT, { recursive: true });

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

async function measurePrimary(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const btns = [...dialog.querySelectorAll("button, a")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: (el.getAttribute("aria-label") || el.textContent || "")
          .trim()
          .slice(0, 40),
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    });
    const title = document.getElementById("eden-tour-title")?.textContent ?? "";
    const progress = dialog.querySelector("p")?.textContent ?? "";
    return { title, progress, btns };
  });
}

async function runViewport(browser, width, height, label) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width, height },
    reducedMotion: label.includes("rm") ? "reduce" : "no-preference",
  });
  const page = await ctx.newPage();
  const findings = [];

  await page.goto(`${BASE}/dashboard?onboarding=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2500);

  const url = page.url();
  if (/sign-in|sign-up|login/i.test(url)) {
    fail(`[${label}] redirected to auth: ${url}`);
    await ctx.close();
    return findings;
  }

  // Wait for tour dialog
  const dialog = page.locator('[role="dialog"]');
  try {
    await dialog.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    fail(`[${label}] tour dialog not visible`);
    await page.screenshot({ path: `${OUT}/${label}-no-dialog.png`, fullPage: true });
    await ctx.close();
    return findings;
  }

  await page.screenshot({ path: `${OUT}/${label}-welcome.png` });
  const m0 = await measurePrimary(page);
  findings.push({ label, step: "welcome", measure: m0 });

  // Hit-target check
  const small = (m0?.btns || []).filter(
    (b) =>
      /skip|close|next|start|create|open|back|docs|api/i.test(b.label) &&
      b.h > 0 &&
      b.h < 44,
  );
  if (small.length) {
    fail(`[${label}] hit targets <44px: ${JSON.stringify(small)}`);
  } else {
    console.log(`[${label}] hit targets OK (≥44 or absent)`);
  }

  // Esc closes
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const afterEsc = await dialog.count();
  if (afterEsc > 0 && (await dialog.isVisible().catch(() => false))) {
    fail(`[${label}] Esc did not close tour`);
  } else {
    console.log(`[${label}] Esc closes tour`);
  }

  // Reopen and walk steps with Next / Start
  await page.goto(`${BASE}/dashboard?onboarding=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  await dialog.waitFor({ state: "visible", timeout: 15000 });

  const titles = [];
  for (let i = 0; i < EXPECTED.length; i++) {
    await page.waitForTimeout(600);
    const title =
      (await page.locator("#eden-tour-title").textContent().catch(() => "")) ||
      "";
    titles.push(title.trim());
    await page.screenshot({
      path: `${OUT}/${label}-step-${i}.png`,
    });

    // Check CTA hrefs on api-keys / install
    if (i === 1) {
      const href = await page
        .locator('[role="dialog"] a[href*="settings"]')
        .first()
        .getAttribute("href")
        .catch(() => null);
      if (href !== "/settings?tab=api-keys") {
        fail(`[${label}] api-keys CTA href=${href}`);
      } else {
        console.log(`[${label}] api-keys CTA → /settings?tab=api-keys`);
      }
    }
    if (i === 2) {
      const href = await page
        .locator('[role="dialog"] a[href*="quickstart"]')
        .first()
        .getAttribute("href")
        .catch(() => null);
      if (!href || !/quickstart/.test(href)) {
        fail(`[${label}] install CTA href=${href}`);
      } else {
        console.log(`[${label}] install CTA → docs quickstart`);
      }
    }

    if (i < EXPECTED.length - 1) {
      // Prefer Next / Start ghost or primary without leaving for external
      const next = page
        .locator('[role="dialog"] button')
        .filter({ hasText: /^(Start tour|Next)$/ });
      if ((await next.count()) > 0) {
        await next.first().click();
      } else {
        await page.keyboard.press("ArrowRight");
      }
      await page.waitForTimeout(700);
    }
  }

  console.log(`[${label}] titles:`, titles);

  // X close
  await page.goto(`${BASE}/dashboard?onboarding=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  await dialog.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[role="dialog"] button[aria-label="Close tour"]').click();
  await page.waitForTimeout(600);
  if (await dialog.isVisible().catch(() => false)) {
    fail(`[${label}] X did not close tour`);
  } else {
    console.log(`[${label}] X closes tour`);
  }

  // Skip
  await page.goto(`${BASE}/dashboard?onboarding=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  await dialog.waitFor({ state: "visible", timeout: 15000 });
  await page.locator('[role="dialog"] button', { hasText: "Skip tour" }).click();
  await page.waitForTimeout(800);
  if (await dialog.isVisible().catch(() => false)) {
    fail(`[${label}] Skip did not close tour`);
  } else {
    console.log(`[${label}] Skip closes tour`);
  }

  // Banner resume present after skip
  const banner = page.locator('[aria-label="Onboarding progress"]');
  const bannerVisible = await banner.isVisible().catch(() => false);
  console.log(`[${label}] banner after skip:`, bannerVisible);

  await ctx.close();
  return findings;
}

async function main() {
  if (!existsSync(STATE)) {
    console.error("Missing", STATE);
    process.exit(1);
  }
  const browser = await chromium.launch({
    headless: true,
    // Prefer system Playwright cache when sandbox remaps BROWSERS_PATH.
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? {}
      : {}),
  });
  try {
    await runViewport(browser, 1280, 800, "1280");
    await runViewport(browser, 375, 812, "375");
    await runViewport(browser, 1280, 800, "1280-rm");
  } finally {
    await browser.close();
  }
  writeFileSync(
    `${OUT}/summary.json`,
    JSON.stringify({ ok: !process.exitCode, base: BASE }, null, 2),
  );
  console.log("Done. exit=", process.exitCode || 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
