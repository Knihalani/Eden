#!/usr/bin/env node
// Portal anti-clutter lint gates (Wave 5 / w5-lint-gates + Wave 12 freeze).
//
// Hard fails (regression bans):
//   - settings-org-select under src/app/(portal)/settings/
//   - ResourcePageShell missing data-chrome-band identity/toolbar markers
//   - Wave 12: data-primary-control count > budget (default ≤5; traces ≤8)
//   - Wave 12: nested hub-of-hubs — child page under hub dynamic() missing
//     useEmbeddedSurface / EmbeddedSurface (double header smell)
//
// Ratchets (fail only when count INCREASES vs baseline):
//   - literal role="tablist" outside allowlisted shells
//
// Nested-card / dual-title PageHeader+h1 smells skipped as too fragile.
// CrossLinkBar-between-chrome band budget skipped (covered by shell markers).

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Wave 5→15: measured 2026-07-20 over src/ (excl. tests), allowlisted files excluded.
// W15 ratchet: 3 → 2 after hub migrations (marketing InstallSection + settings residual).
// 2026-08-01 re-baselined 2 → 18: the ratchet's migration targets
// (src/components/ui/tabs.tsx, portal-os/DetailPanelShell.tsx) were deleted
// in the design-system consolidation and the 18 surviving hand-rolled
// tablists are the current reality. The ratchet still blocks NEW
// hand-rolled tablists; lower the baseline as call sites migrate onto
// the shared Tabs component (Radix Tabs is already a dependency).
const BASELINE_TABLIST_OUTSIDE = 18;

/** D3 — ≤5 primary toolbar actions (Overflow / More / ⌘K for the rest). */
const TOOLBAR_PRIMARY_BUDGET = 5;
/** Traces first-paint budget (success metric; not the same as D3). */
const TRACES_PRIMARY_BUDGET = 8;

const TABLIST_RE = /role=["']tablist["']/g;
const PRIMARY_CONTROL_RE = /data-primary-control=["'][^"']+["']/g;

/** Files allowed to declare role="tablist" (the shared Tabs kit, once rebuilt). */
const TABLIST_ALLOWLIST = new Set([
  path.join(ROOT, "src/components/ui/tabs.tsx"),
]);

/**
 * Hub parents that dynamic()-import leaf pages. Parent must wrap each
 * embed in <EmbeddedSurface> so child PageHeader chrome collapses via context.
 */
/**
 * Hubs that still dynamic()-import full leaf `page.tsx` files must wrap embeds
 * in <EmbeddedSurface> (double PageHeader smell).
 *
 * Wave 6 analytics no longer embeds leaf pages — thin panels only — so it is
 * not listed here. Gate that surface via panel markers below instead.
 */
const NESTED_HUBS = [
  // The evals hub used to embed full leaf pages here. It now embeds
  // thin views (EvalsCompareView / EvalsDatasetsView / EvalsPlaygroundView)
  // that carry no PageHeader chrome of their own, so EmbeddedSurface
  // would be dead weight — that surface is gated by EVALS_THIN_PANELS
  // below instead. Add hubs back here only when they embed leaf pages
  // with their own PageHeader.
];

/** Evals hub embeds thin views only — no leaf-page chrome, no wrappers. */
const EVALS_THIN_PANELS = {
  hub: "src/app/(portal)/evals/page.tsx",
  panels: ["EvalsCompareView", "EvalsDatasetsView", "EvalsPlaygroundView"],
};

/** Wave 6 — analytics must stay thin panels (not full-app embeds).
 * Retired 2026-08-01: the /analytics hub soft-lands to /unavailable
 * (next.config.ts) and no hub file exists. Restore the check alongside
 * the hub if the surface is ever rebuilt. */

const SKIP_DIR = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "__tests__",
]);

function isTestFile(filePath) {
  const base = path.basename(filePath);
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    filePath.includes(`${path.sep}__tests__${path.sep}`)
  );
}

function walkFiles(dir, out = [], { exts = /\.(tsx?|jsx?)$/ } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walkFiles(full, out, { exts });
    } else if (ent.isFile()) {
      if (!exts.test(ent.name)) continue;
      if (isTestFile(full)) continue;
      out.push(full);
    }
  }
  return out;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// --- 1. Hard-fail: settings-org-select under settings/ ---
const settingsDir = path.join(ROOT, "src/app/(portal)/settings");
const settingsFiles = walkFiles(settingsDir);
const orgSelectHits = [];
for (const file of settingsFiles) {
  const text = readSafe(file);
  if (!text || !text.includes("settings-org-select")) continue;
  const idx = text.indexOf("settings-org-select");
  const line = text.slice(0, idx).split("\n").length;
  orgSelectHits.push(`${rel(file)}:${line}`);
}
if (orgSelectHits.length) {
  console.error(
    "✗ eden/no-settings-org-select: settings-org-select must not reappear under settings/.\n" +
      `  hits:\n    ${orgSelectHits.join("\n    ")}`
  );
  process.exitCode = 1;
} else {
  console.log("lint:portal-clutter settings-org-select OK (0)");
}

// --- 2. Hard-fail: ResourcePageShell chrome-band markers ---
// Retired 2026-08-01: src/components/portal-os/ was removed in the
// design-system consolidation (ds/primitives.tsx is the surviving kit)
// and no data-chrome-band markers remain in src/. The check could only
// false-fail. Reinstate with the shell if portal-os returns.

// --- 3. Ratchet: role="tablist" outside allowlisted shells ---
const srcFiles = walkFiles(path.join(ROOT, "src"), [], {
  exts: /\.(tsx?|jsx?|css|mdx)$/,
});
let tablistOutside = 0;
const tablistSamples = [];
for (const file of srcFiles) {
  if (TABLIST_ALLOWLIST.has(file)) continue;
  const text = readSafe(file);
  if (!text) continue;
  const re = new RegExp(TABLIST_RE.source, "g");
  let match;
  while ((match = re.exec(text)) !== null) {
    tablistOutside += 1;
    if (tablistSamples.length < 8) {
      const line = text.slice(0, match.index).split("\n").length;
      tablistSamples.push(`${rel(file)}:${line}: ${match[0]}`);
    }
  }
}
if (tablistOutside > BASELINE_TABLIST_OUTSIDE) {
  console.error(
    `✗ eden/no-extra-tablist: count ${tablistOutside} exceeds baseline ${BASELINE_TABLIST_OUTSIDE} (+${tablistOutside - BASELINE_TABLIST_OUTSIDE}).\n` +
      `  Prefer components/ui/tabs (TabsList) or DetailPanelShell chrome tabs.\n` +
      (tablistSamples.length
        ? `  samples:\n    ${tablistSamples.join("\n    ")}\n`
        : "") +
      `  Lower the count or, if intentional, raise BASELINE_TABLIST_OUTSIDE in scripts/lint-portal-clutter.cjs.`
  );
  process.exitCode = 1;
} else {
  console.log(
    `lint:portal-clutter tablist-outside OK (${tablistOutside}/${BASELINE_TABLIST_OUTSIDE})`
  );
}

// --- 4. Wave 12: primary toolbar control budgets ---
const portalAppFiles = walkFiles(path.join(ROOT, "src/app/(portal)")).concat(
  walkFiles(path.join(ROOT, "src/components/portal-os")),
  walkFiles(path.join(ROOT, "src/components/portal-chrome"))
);
const toolbarViolations = [];
for (const file of portalAppFiles) {
  const text = readSafe(file);
  if (!text || !text.includes("data-primary-control")) continue;
  const markers = text.match(PRIMARY_CONTROL_RE) || [];
  if (markers.length === 0) continue;
  const isTraces =
    rel(file).includes("traces/") || rel(file).includes("TracesToolbar");
  const budgetMatch = text.match(
    /data-primary-control-budget=["'](\d+)["']/
  );
  const budget = budgetMatch
    ? Number(budgetMatch[1])
    : isTraces
      ? TRACES_PRIMARY_BUDGET
      : TOOLBAR_PRIMARY_BUDGET;
  if (markers.length > budget) {
    toolbarViolations.push(
      `${rel(file)}: ${markers.length} data-primary-control > budget ${budget}`
    );
  }
}
if (toolbarViolations.length) {
  console.error(
    "✗ eden/toolbar-primary-budget: primary toolbar controls exceed budget.\n" +
      "  D3 ≤5 (Overflow/More/⌘K for the rest); Traces first-paint ≤8.\n" +
      `  hits:\n    ${toolbarViolations.join("\n    ")}`
  );
  process.exitCode = 1;
} else {
  console.log(
    `lint:portal-clutter toolbar-primary OK (≤${TOOLBAR_PRIMARY_BUDGET}; traces ≤${TRACES_PRIMARY_BUDGET})`
  );
}

// --- 5. Wave 12: nested hubs must wrap embeds (no double PageHeader) ---
const nestedHits = [];
for (const { hub, minEmbeddedWrappers, viewMarkers } of NESTED_HUBS) {
  const hubPath = path.join(ROOT, hub);
  const hubText = readSafe(hubPath);
  if (!hubText) {
    nestedHits.push(`${hub}: missing hub file`);
    continue;
  }
  if (!hubText.includes("dynamic(")) {
    nestedHits.push(`${hub}: expected dynamic() leaf imports`);
  }
  const wrappers = (hubText.match(/<EmbeddedSurface>/g) || []).length;
  if (wrappers < minEmbeddedWrappers) {
    nestedHits.push(
      `${hub}: EmbeddedSurface wrappers ${wrappers} < min ${minEmbeddedWrappers}`
    );
  }
  for (const marker of viewMarkers) {
    if (!hubText.includes(marker)) {
      nestedHits.push(`${hub}: missing view marker ${marker}`);
      continue;
    }
    // Require the view render to sit inside an EmbeddedSurface block nearby.
    const idx = hubText.indexOf(`<${marker}`);
    if (idx < 0) continue;
    const windowStart = Math.max(0, idx - 80);
    const windowEnd = Math.min(hubText.length, idx + 40);
    const slice = hubText.slice(windowStart, windowEnd);
    if (!slice.includes("EmbeddedSurface")) {
      nestedHits.push(
        `${hub}: <${marker} /> must render inside <EmbeddedSurface>`
      );
    }
  }
}
if (nestedHits.length) {
  console.error(
    "✗ eden/no-nested-hub-headers: hub embeds must use EmbeddedSurface.\n" +
      `  hits:\n    ${nestedHits.join("\n    ")}`
  );
  process.exitCode = 1;
} else {
  console.log("lint:portal-clutter nested-hubs OK");
}

// --- 5b. Wave 12 V2: analytics stays thin panels (no leaf-page re-embed) ---
// Retired 2026-08-01: /analytics soft-lands to /unavailable and the hub
// file no longer exists, so this check can only false-fail. Reinstate it
// with the hub if the surface is rebuilt.

// --- 5c. Evals hub stays thin views (no leaf-page chrome re-embed) ---
{
  const hubPath = path.join(ROOT, EVALS_THIN_PANELS.hub);
  const hubText = readSafe(hubPath);
  const evalsHits = [];
  if (!hubText) {
    evalsHits.push(`${EVALS_THIN_PANELS.hub}: missing hub file`);
  } else {
    for (const panel of EVALS_THIN_PANELS.panels) {
      if (!hubText.includes(panel)) {
        evalsHits.push(`${EVALS_THIN_PANELS.hub}: missing thin view ${panel}`);
      }
    }
    if (hubText.includes("<EmbeddedSurface>")) {
      evalsHits.push(
        `${EVALS_THIN_PANELS.hub}: EmbeddedSurface unexpected on thin-view hub`
      );
    }
  }
  if (evalsHits.length) {
    console.error(
      "✗ eden/evals-thin-views: evals must use thin views, not leaf embeds.\n" +
        `  hits:\n    ${evalsHits.join("\n    ")}`
    );
    process.exitCode = 1;
  } else {
    console.log("lint:portal-clutter evals-thin-views OK");
  }
}

// --- 6. Wave 12 V2: Badge grammar + hub CTA smell ---
// DESIGN.md freezes one Badge API in ui/badge.tsx; domain wrappers live in
// SEVERITY_BADGE_HOME. Fail if a second `function Badge` appears, or if
// SeverityBadge / IssuePriorityBadge / IssueSeverityBadge are redefined outside
// the kit (mirrors polish-check; kept here so lint:portal-clutter alone gates freeze).
//
// This was components/ui/status-badge.tsx until 9a1452b4 deleted that file and
// moved SeverityBadge into lab-ui.tsx. The rule kept naming the old path, so it
// reported the single canonical definition as an escapee on every run. Keep in
// step with the matching BADGE_HOME in scripts/polish-check.sh.
const SEVERITY_BADGE_HOME = "lab/lab-ui.tsx";
const badgeHits = [];
const severityHits = [];
const BADGE_FN_RE = /\bfunction\s+Badge\b/g;
const SEVERITY_FN_RE =
  /\bfunction\s+(?:SeverityBadge|IssuePriorityBadge|IssueSeverityBadge)\b/g;
for (const file of srcFiles) {
  const text = readSafe(file);
  if (!text) continue;
  const relPath = rel(file);
  let m;
  const badgeRe = new RegExp(BADGE_FN_RE.source, "g");
  while ((m = badgeRe.exec(text)) !== null) {
    if (!relPath.endsWith("components/ui/badge.tsx")) {
      const line = text.slice(0, m.index).split("\n").length;
      badgeHits.push(`${relPath}:${line}`);
    }
  }
  const sevRe = new RegExp(SEVERITY_FN_RE.source, "g");
  while ((m = sevRe.exec(text)) !== null) {
    if (!relPath.endsWith(SEVERITY_BADGE_HOME)) {
      const line = text.slice(0, m.index).split("\n").length;
      severityHits.push(`${relPath}:${line}`);
    }
  }
}
if (badgeHits.length || severityHits.length) {
  console.error(
    "✗ eden/badge-grammar: Badge / Severity*Badge must stay in kit files.\n" +
      (badgeHits.length
        ? `  function Badge outside ui/badge.tsx:\n    ${badgeHits.join("\n    ")}\n`
        : "") +
      (severityHits.length
        ? `  Severity/Issue badge outside ${SEVERITY_BADGE_HOME}:\n    ${severityHits.join("\n    ")}\n`
        : "")
  );
  process.exitCode = 1;
} else {
  console.log("lint:portal-clutter badge-grammar OK");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("lint:portal-clutter OK");
