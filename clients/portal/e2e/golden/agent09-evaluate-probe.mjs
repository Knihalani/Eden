#!/usr/bin/env node
/**
 * Agent 09 deep probe — Evaluate (/evals, /playgrounds, experiments compare) @375/@1280.
 * Uses e2e/.auth-state.json. API cold (503) is OK.
 *
 * Soft skip (exit 0): E6_PROBE_DRY=1 or missing e2e/.auth-state.json
 *   documents auth debt without failing CI dry-run.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTAL = resolve(__dirname, "../..");
const STATE = resolve(PORTAL, "e2e/.auth-state.json");
const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const OUT = resolve(PORTAL, "e2e/golden/screenshots/agent09-evaluate");
const DRY =
  process.env.E6_PROBE_DRY === "1" ||
  process.env.E6_PROBE_DRY === "true" ||
  !existsSync(STATE);

/** Wave E6 / E4 compare-diff selectors documented in W_E6_EVAL_COMPARE_CONTRACT. */
const COMPARE_SELECTORS = {
  shell: '[data-wave-e4-experiments="shell"]',
  compareCta: '[data-wave-e4-cta="compare"]',
  baseline: "[data-wave-e4-baseline]",
  diff: "[data-wave-e4-diff]",
  compare: "[data-wave-e4-compare]",
  e6Eval: '[data-wave-e6-eval="experiments"]',
  e6Any: "[data-wave-e6-eval],[data-wave-e6-compare],[data-wave-e6-diff]",
  promoteCompareReady: '[data-wave-e3-promote="compare-ready"]',
};

if (DRY) {
  const reason =
    process.env.E6_PROBE_DRY === "1" || process.env.E6_PROBE_DRY === "true"
      ? "E6_PROBE_DRY=1"
      : `missing auth state: ${STATE}`;
  console.log(`SKIP: agent09 evaluate probe soft-skip (${reason})`);
  console.log("Debt: live compare/diff @375/@1280 needs e2e/.auth-state.json + portal.");
  console.log(
    "Routes when live: /evals, /evals?tab=experiments, /evals?tab=studio, /playgrounds",
  );
  console.log("Markers: data-wave-e4-compare|diff|baseline|cta + optional data-wave-e6-*");
  console.log("RESULT: SKIP (exit 0)");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const { chromium } = await import("playwright");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

async function probe(page, label, path) {
  const consoles = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoles.push(msg.text().slice(0, 160));
  });
  page.on("pageerror", (err) => consoles.push(`pageerror:${String(err).slice(0, 160)}`));

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const url = page.url();
  if (/sign-in|sign-up|login/i.test(url)) {
    fail(`[${label}] redirected to auth: ${url}`);
    return { url, consoles, ok: false };
  }

  const shot = `${OUT}/${label}.png`;
  await page.screenshot({ path: shot, fullPage: true });

  const isExperiments = /tab=experiments/.test(path);
  const isPlaygrounds =
    path.includes("tab=playgrounds") || path === "/playgrounds" || path.startsWith("/playgrounds?");

  const data = await page.evaluate(
    ({ compareSels, isExperiments: expTab, isPlaygrounds: pgTab }) => {
      const text = document.body?.innerText || "";
      const h1 = document.querySelector("h1")?.textContent?.trim() || "";
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => ({
        label: (t.textContent || "").trim(),
        selected: t.getAttribute("aria-selected") === "true",
        h: Math.round(t.getBoundingClientRect().height),
      }));
      const primaries = [...document.querySelectorAll("button, a")]
        .map((el) => {
          const label = (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 48);
          const r = el.getBoundingClientRect();
          return {
            label,
            h: Math.round(r.height),
            disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
            href: el.getAttribute("href") || "",
            describedBy: el.getAttribute("aria-describedby") || "",
          };
        })
        .filter((b) =>
          /create|new playground|run matrix|promote|docs quickstart|playground|dataset|compare/i.test(
            b.label,
          ),
        );
      const improveAsEvalCta = [...document.querySelectorAll("a, button")].some((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        const href = (el.getAttribute("href") || "").toLowerCase();
        return (
          href.includes("/improve") &&
          /(eval|score|playground|experiment|judge)/i.test(t) &&
          !/not production|offline/i.test(t)
        );
      });
      const reasons = [...document.querySelectorAll("#pg-run-reason, #pg-promote-reason")].map(
        (el) => (el.textContent || "").trim(),
      );
      const empty =
        text.includes("No playgrounds yet") ||
        text.includes("An eval scores") ||
        /No experiments yet/i.test(text);
      const q = (s) => document.querySelector(s) != null;
      const compare = expTab
        ? {
            shell: q(compareSels.shell),
            compareCta: q(compareSels.compareCta),
            baseline: q(compareSels.baseline),
            diff: q(compareSels.diff),
            compare: q(compareSels.compare),
            e6Eval: q(compareSels.e6Eval),
            e6Any: q(compareSels.e6Any),
            emptyExperiments: /No experiments yet/i.test(text),
            hasCompareCopy: /Compare selected|Baseline|Diff mode/i.test(text),
          }
        : null;
      const playgroundCompareReady = pgTab
        ? {
            promoteCompareReady: q(compareSels.promoteCompareReady),
            e6Any: q(compareSels.e6Any),
          }
        : null;
      const e6Attrs = [
        ...document.querySelectorAll(
          "[data-wave-e6-eval],[data-wave-e6-compare],[data-wave-e6-diff]",
        ),
      ].map((el) => ({
        eval: el.getAttribute("data-wave-e6-eval"),
        compare: el.getAttribute("data-wave-e6-compare"),
        diff: el.getAttribute("data-wave-e6-diff"),
      }));
      return {
        h1,
        tabs,
        primaries,
        improveAsEvalCta,
        reasons,
        empty,
        hasWhatIsEval: /An eval scores agent output/i.test(text),
        hasFirstRun: /dataset\s*→\s*playground\s*→\s*experiment/i.test(text),
        hasStudioStubNoise: /live\s*[—-]\s*not a stub/i.test(text),
        scorerJsonDump: /scorers:\s*\[/i.test(text),
        compare,
        playgroundCompareReady,
        e6Attrs,
      };
    },
    { compareSels: COMPARE_SELECTORS, isExperiments, isPlaygrounds },
  );

  console.log(`[${label}] url=${url}`);
  console.log(`[${label}] h1=${data.h1}`);
  console.log(`[${label}] tabs=${JSON.stringify(data.tabs)}`);
  console.log(`[${label}] primaries=${JSON.stringify(data.primaries)}`);
  console.log(`[${label}] reasons=${JSON.stringify(data.reasons)}`);
  console.log(`[${label}] whatIsEval=${data.hasWhatIsEval} firstRun=${data.hasFirstRun}`);
  console.log(`[${label}] improveAsEvalCta=${data.improveAsEvalCta}`);
  console.log(`[${label}] studioStubNoise=${data.hasStudioStubNoise} scorerDump=${data.scorerJsonDump}`);
  if (data.compare) console.log(`[${label}] compare=${JSON.stringify(data.compare)}`);
  if (data.playgroundCompareReady) {
    console.log(`[${label}] playgroundCompareReady=${JSON.stringify(data.playgroundCompareReady)}`);
  }
  if (data.e6Attrs?.length) console.log(`[${label}] e6Markers=${JSON.stringify(data.e6Attrs)}`);
  if (consoles.length) console.log(`[${label}] console errors: ${consoles.slice(0, 5).join(" | ")}`);

  // Checks
  if (
    !data.hasWhatIsEval &&
    path.startsWith("/evals") &&
    !path.includes("tab=playgrounds") &&
    !isExperiments
  ) {
    if (!data.hasWhatIsEval) fail(`[${label}] missing what-is-eval copy`);
  }
  if (path === "/evals" || (path.startsWith("/evals?") && !isExperiments && !path.includes("tab="))) {
    if (!data.hasFirstRun && path === "/evals") fail(`[${label}] missing first-run path copy`);
  }
  if (data.improveAsEvalCta) fail(`[${label}] Improve linked as Evaluate scoring CTA`);
  if (data.hasStudioStubNoise) fail(`[${label}] studio stub noise still present`);
  if (data.scorerJsonDump) fail(`[${label}] scorer JSON dump still present`);

  if (isExperiments && data.compare) {
    const c = data.compare;
    if (!c.shell && !c.e6Eval) {
      fail(
        `[${label}] experiments shell missing (${COMPARE_SELECTORS.shell} / ${COMPARE_SELECTORS.e6Eval})`,
      );
    } else if (c.emptyExperiments) {
      console.log(`[${label}] empty experiments grammar OK`);
    } else {
      if (!c.compareCta && !c.hasCompareCopy) {
        fail(`[${label}] missing compare CTA / compare copy on experiments tab`);
      }
      if (c.compare || c.baseline || c.diff) {
        if (c.compare && !c.baseline) {
          fail(`[${label}] compare panel open without baseline picker`);
        }
        if (c.compare && !c.diff) {
          fail(`[${label}] compare panel open without diff mode controls`);
        }
        console.log(
          `[${label}] compare detail OK (baseline=${c.baseline} diff=${c.diff} e6=${c.e6Eval || c.e6Any})`,
        );
      } else {
        console.log(`[${label}] list loaded without open compare detail (CTA/copy OK)`);
      }
    }
    if (c.e6Eval || c.e6Any || (data.e6Attrs && data.e6Attrs.length)) {
      console.log(`[${label}] data-wave-e6-* present`);
    }
  }

  const smallTabs = (data.tabs || []).filter((t) => t.h > 0 && t.h < 44);
  if (smallTabs.length) fail(`[${label}] tab hit targets <44px: ${JSON.stringify(smallTabs)}`);

  const smallPrimary = (data.primaries || []).filter(
    (b) =>
      /create playground|new playground|run matrix|promote|docs quickstart/i.test(b.label) &&
      b.h > 0 &&
      b.h < 44,
  );
  if (smallPrimary.length) {
    fail(`[${label}] primary hit targets <44px: ${JSON.stringify(smallPrimary)}`);
  }

  const promote = (data.primaries || []).find((b) => /promote/i.test(b.label));
  if (promote?.disabled && !data.reasons.some((r) => /dataset/i.test(r))) {
    fail(`[${label}] Promote disabled without visible reason`);
  }

  return { url, consoles, data, shot, ok: true };
}

async function runViewport(browser, width, height, tag) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const results = [];

  results.push(await probe(page, `${tag}-evals`, "/evals"));
  results.push(await probe(page, `${tag}-evals-experiments`, "/evals?tab=experiments"));
  results.push(await probe(page, `${tag}-evals-studio`, "/evals?tab=studio"));
  results.push(await probe(page, `${tag}-playgrounds`, "/playgrounds"));

  await page.goto(`${BASE}/evals`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return {
      role: el?.getAttribute("role") || el?.tagName || "",
      text: (el?.textContent || "").trim().slice(0, 40),
    };
  });
  console.log(`[${tag}-kbd] focused=${JSON.stringify(focused)}`);
  await page.screenshot({ path: `${OUT}/${tag}-kbd-focus.png` });

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
  console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
} finally {
  await browser.close();
}
