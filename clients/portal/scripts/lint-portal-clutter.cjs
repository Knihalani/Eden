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
const BASELINE_TABLIST_OUTSIDE = 2;

/** D3 — ≤5 primary toolbar actions (Overflow / More / ⌘K for the rest). */
const TOOLBAR_PRIMARY_BUDGET = 5;
/** Traces first-paint budget (success metric; not the same as D3). */
const TRACES_PRIMARY_BUDGET = 8;

const TABLIST_RE = /role=["']tablist["']/g;
const PRIMARY_CONTROL_RE = /data-primary-control=["'][^"']+["']/g;

/** Files allowed to declare role="tablist" (or Radix List that owns it). */
const TABLIST_ALLOWLIST = new Set([
  path.join(ROOT, "src/components/ui/tabs.tsx"),
  path.join(ROOT, "src/components/portal-os/DetailPanelShell.tsx"),
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
  {
    hub: "src/app/(portal)/evals/page.tsx",
    minEmbeddedWrappers: 5,
    viewMarkers: [
      "DatasetsView",
      "PlaygroundsView",
      "ExperimentsView",
      "LabelingView",
      "StudioView",
      "SyntheticView",
      "EvalView",
    ],
  },
];

/** Wave 6 — analytics must stay thin panels (not full-app embeds). */
const ANALYTICS_THIN_PANELS = {
  hub: "src/app/(portal)/analytics/page.tsx",
  panels: ["InsightsPanel", "TopicsPanel", "ToolsPanel", "UsersPanel"],
  banned: ["InsightsView", "TopicsView", "ToolsView", "UsersView"],
};

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

// --- 2. Hard-fail: ResourcePageShell chrome-band markers (sibling landed) ---
const shellPath = path.join(
  ROOT,
  "src/components/portal-os/ResourcePageShell.tsx"
);
const shellText = readSafe(shellPath);
if (!shellText) {
  console.error(
    "✗ eden/chrome-band-markers: ResourcePageShell.tsx not found."
  );
  process.exitCode = 1;
} else {
  const hasIdentity = shellText.includes('data-chrome-band="identity"');
  const hasToolbar = shellText.includes('data-chrome-band="toolbar"');
  if (!hasIdentity || !hasToolbar) {
    console.error(
      "✗ eden/chrome-band-markers: ResourcePageShell must contain " +
        'data-chrome-band="identity" and data-chrome-band="toolbar".\n' +
        `  identity=${hasIdentity} toolbar=${hasToolbar}`
    );
    process.exitCode = 1;
  } else {
    console.log("lint:portal-clutter chrome-band markers OK");
  }
}

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
{
  const hubPath = path.join(ROOT, ANALYTICS_THIN_PANELS.hub);
  const hubText = readSafe(hubPath);
  const analyticsHits = [];
  if (!hubText) {
    analyticsHits.push(`${ANALYTICS_THIN_PANELS.hub}: missing hub file`);
  } else {
    for (const panel of ANALYTICS_THIN_PANELS.panels) {
      if (!hubText.includes(panel)) {
        analyticsHits.push(`${ANALYTICS_THIN_PANELS.hub}: missing thin panel ${panel}`);
      }
    }
    for (const banned of ANALYTICS_THIN_PANELS.banned) {
      if (hubText.includes(banned)) {
        analyticsHits.push(
          `${ANALYTICS_THIN_PANELS.hub}: banned leaf-embed marker ${banned}`
        );
      }
    }
    if (hubText.includes("<EmbeddedSurface>")) {
      analyticsHits.push(
        `${ANALYTICS_THIN_PANELS.hub}: EmbeddedSurface unexpected on thin-panel hub`
      );
    }
  }
  if (analyticsHits.length) {
    console.error(
      "✗ eden/analytics-thin-panels: analytics must use thin panels, not leaf embeds.\n" +
        `  hits:\n    ${analyticsHits.join("\n    ")}`
    );
    process.exitCode = 1;
  } else {
    console.log("lint:portal-clutter analytics-thin-panels OK");
  }
}

// --- 6. Wave 12 V2: Badge grammar + hub CTA smell ---
// DESIGN.md freezes one Badge API in ui/badge.tsx; domain wrappers live in
// status-badge.tsx. Fail if a second `function Badge` appears, or if
// SeverityBadge / IssuePriorityBadge / IssueSeverityBadge are redefined outside
// the kit (mirrors polish-check; kept here so lint:portal-clutter alone gates freeze).
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
    if (!relPath.endsWith("components/ui/status-badge.tsx")) {
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
        ? `  Severity/Issue badge outside ui/status-badge.tsx:\n    ${severityHits.join("\n    ")}\n`
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
