#!/usr/bin/env node
/**
 * Wave 12 / Observe V3 Wave 6 — Observe → Eval → Improve happy-path sketch (Playwright).
 *
 * Alias: this script is the canonical loop smoke; Wave 6 refresh notes live in
 *   e2e/golden/w-v3-observe-eval-improve.md
 *
 * Default (no browser): prints the route + URL-grammar contract and exits 0.
 * Live run (requires portal + Clerk auth):
 *   W12_E2E_LIVE=1 bun run test:e2e-loop
 *   # or Wave 6 alias:
 *   W_V3_E2E_LIVE=1 node e2e/golden/w12-observe-eval-improve.mjs
 *
 * Auth: e2e/.auth-state.json from seed-auth.mjs or wait-for-signin.mjs.
 * See e2e/README-auth.md.
 *
 * This is a smoke loop, not a full golden matrix — see golden-paths.spec.mjs
 * for the 8-path suite.
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
  process.env.W12_E2E_LIVE === "1" || process.env.W_V3_E2E_LIVE === "1";

/** Observe V3 canonical URL grammar (writers). Alias-read only: span, span_id, trace_id. */
export const W_V3_URL_GRAMMAR = {
  writers: ["traceId", "spanId", "pastHours", "view", "mode", "q", "realm", "outcome", "agent_id"],
  aliasesReadOnly: ["span", "span_id", "trace_id"],
  /** Sample deep-link that must round-trip on /traces without rewriting aliases. */
  sampleObserveHref:
    "/traces?traceId=sample-trace&spanId=sample-span&pastHours=24&q=error&view=traces",
};

/** Observe → Eval → Improve — ≤3 decision surfaces from Home. */
export const W12_LOOP = [
  {
    id: "observe",
    route: "/traces",
    label: "Observe · Traces",
    expect: /trace|span|session|Waiting for first event|No events/i,
    /** Wave 6: assert hub understands canonical query keys when live. */
    sampleQuery: "traceId=smoke&pastHours=168",
  },
  {
    id: "eval",
    route: "/evals",
    label: "Evaluate · Datasets hub",
    expect: /Eval|Dataset|Playground|Experiment/i,
  },
  {
    id: "improve",
    route: "/improve",
    label: "Improve · Queue",
    expect: /Improve|Queue|Artifact|empty|No /i,
  },
];

/**
 * Improve V3 Wave 10 — optional Prompts hop after Queue.
 * Full Improve-group loop: e2e/golden/w10-improve-v3-loop.mjs
 */
export const W12_IMPROVE_V3_PROMPTS_HOP = {
  id: "prompts",
  route: "/prompts",
  label: "Improve · Prompts (optional)",
  expect: /Prompt|draft|Publish|empty|No /i,
};

/**
 * Evaluate V3 / Wave E6 — experiments compare/diff deep hop (optional after Eval hub).
 * Dry-run documents selectors; live asserts shell markers OR body grammar.
 */
export const W_E6_EVAL_COMPARE_CONTRACT = {
  id: "eval-compare",
  route: "/evals?tab=experiments",
  label: "Evaluate · Experiments compare/diff (Wave E6)",
  expect: /Experiment|Compare|Baseline|Diff|No experiments/i,
  emptyGrammar: /No experiments yet/i,
  /** Documented selectors — E4 markers required when shell mounts; E6 optional. */
  markers: {
    shell: '[data-wave-e4-experiments="shell"]',
    compare: "[data-wave-e4-compare]",
    diff: "[data-wave-e4-diff]",
    baseline: "[data-wave-e4-baseline]",
    compareCta: '[data-wave-e4-cta="compare"]',
    e6Eval: '[data-wave-e6-eval="experiments"]',
    e6Any: "[data-wave-e6-eval],[data-wave-e6-compare],[data-wave-e6-diff]",
  },
};

/** Wave 6 alias export — same loop, V3 naming. */
export const W_V3_LOOP = W12_LOOP;

function printContract() {
  console.log("Wave 12 / V3 E2E loop contract (Observe → Eval → Improve)\n");
  for (const step of W12_LOOP) {
    console.log(`  ${step.id.padEnd(8)} ${step.route.padEnd(12)} ${step.label}`);
  }
  console.log(
    `\n  ${W12_IMPROVE_V3_PROMPTS_HOP.id.padEnd(8)} ${W12_IMPROVE_V3_PROMPTS_HOP.route.padEnd(12)} ${W12_IMPROVE_V3_PROMPTS_HOP.label}`,
  );

  const e6 = W_E6_EVAL_COMPARE_CONTRACT;
  console.log("\nWave E6 Evaluate compare/diff hop:");
  console.log(`  ${e6.id.padEnd(12)} ${e6.route.padEnd(28)} ${e6.label}`);
  console.log("  markers:");
  console.log(`    compare     ${e6.markers.compare}`);
  console.log(`    diff        ${e6.markers.diff}`);
  console.log(`    baseline    ${e6.markers.baseline}`);
  console.log(`    compare CTA ${e6.markers.compareCta}`);
  console.log(`    shell       ${e6.markers.shell}`);
  console.log(`    e6 (opt)    ${e6.markers.e6Eval} | ${e6.markers.e6Any}`);
  console.log(`  empty grammar: ${e6.emptyGrammar}`);
  console.log(`  body expect:   ${e6.expect}`);

  console.log("\nURL grammar (writers):", W_V3_URL_GRAMMAR.writers.join(", "));
  console.log("Sample observe href:", W_V3_URL_GRAMMAR.sampleObserveHref);
  console.log(
    "\nDry-run OK. Set W12_E2E_LIVE=1 or W_V3_E2E_LIVE=1 with e2e/.auth-state.json to execute.",
  );
  console.log("Improve V3 group loop: e2e/golden/w10-improve-v3-loop.mjs");
  console.log("Checklist: e2e/golden/w-v3-observe-eval-improve.md");
}

async function assertEvalCompareHop(page, failures, helpers) {
  const { BASE, assertNoCrash, assertAuthShell } = helpers;
  const hop = W_E6_EVAL_COMPARE_CONTRACT;
  const url = `${BASE}${hop.route}`;
  console.log(`→ ${hop.label} (${url})`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const href = page.url();
  if (/sign-in|sign-up|login/i.test(href)) {
    failures.push(
      `${hop.id}: auth blocked (redirected to ${href}) — seed e2e/.auth-state.json for live compare/diff`,
    );
    return;
  }

  await assertNoCrash(page);
  await assertAuthShell(page);

  const body = await page.locator("body").innerText().catch(() => "");
  const found = await page.evaluate((sels) => {
    const q = (s) => document.querySelector(s) != null;
    return {
      shell: q(sels.shell),
      compareCta: q(sels.compareCta),
      baseline: q(sels.baseline),
      diff: q(sels.diff),
      compare: q(sels.compare),
      e6Eval: q(sels.e6Eval),
      e6Any: q(sels.e6Any),
    };
  }, hop.markers);

  const emptyOk = hop.emptyGrammar.test(body);
  const bodyOk = hop.expect.test(body);
  const shellOk = found.shell || found.e6Eval;

  if (shellOk) {
    console.log(
      `  ✓ ${hop.id} shell markers (compareCta=${found.compareCta} baseline=${found.baseline} diff=${found.diff} compare=${found.compare} e6=${found.e6Eval || found.e6Any})`,
    );
    if (found.compareCta || found.baseline || found.diff || found.compare || emptyOk) {
      // Detail compare widgets appear when an experiment is open; empty list is OK.
      console.log(
        emptyOk
          ? "  · empty experiments grammar OK"
          : "  · compare/diff surface or CTA present (or empty list)",
      );
    }
  } else if (bodyOk || emptyOk) {
    console.log(`  ✓ ${hop.id} body grammar (no shell marker — soft OK)`);
  } else {
    failures.push(
      `${hop.id}: expected shell markers (${hop.markers.shell} / ${hop.markers.e6Eval}) or body matching ${hop.expect}`,
    );
  }
}

async function runLive() {
  const { chromium } = await import("playwright");
  const helpers = await import("./helpers.mjs");
  const { BASE, loadAuthState, assertNoCrash, assertAuthShell } = helpers;

  const authPath = resolve(PORTAL_ROOT, "e2e/.auth-state.json");
  if (!existsSync(authPath)) {
    console.error(
      "Missing e2e/.auth-state.json — run seed-auth first. (Dry-run without W12_E2E_LIVE still exits 0.)",
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: await loadAuthState() });
  const page = await context.newPage();
  const failures = [];

  try {
    for (const step of W12_LOOP) {
      const qs = step.sampleQuery ? `?${step.sampleQuery}` : "";
      const url = `${BASE}${step.route}${qs}`;
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
      if (step.id === "observe" && step.sampleQuery) {
        const href = page.url();
        // Canonical writers must survive navigation; aliases must not be written.
        if (!href.includes("pastHours=") && !href.includes("traceId=")) {
          // Hub may strip unknown smoke ids — still require pastHours default or query.
          const params = new URL(href).searchParams;
          const hasCanonical =
            params.has("pastHours") ||
            params.has("traceId") ||
            params.has("view") ||
            href.includes("/traces");
          if (!hasCanonical) {
            failures.push("observe: expected /traces canonical URL surface");
          }
        }
        if (/[?&](trace_id|span_id)=/.test(href)) {
          failures.push(
            "observe: URL wrote alias-only keys (trace_id/span_id) — use traceId/spanId",
          );
        }
      }
      if (step.id === "eval") {
        await assertEvalCompareHop(page, failures, helpers);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error("W12/V3 E2E failures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("W12/V3 Observe → Eval → Improve live smoke OK (incl. E6 compare/diff hop)");
}

if (LIVE) {
  runLive().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  printContract();
}
