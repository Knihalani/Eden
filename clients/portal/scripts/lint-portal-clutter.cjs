#!/usr/bin/env node
// Portal anti-clutter lint gates (Wave 5 / w5-lint-gates).
//
// Hard fails (regression bans):
//   - settings-org-select under src/app/(portal)/settings/
//   - ResourcePageShell missing data-chrome-band identity/toolbar markers
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

const TABLIST_RE = /role=["']tablist["']/g;

/** Files allowed to declare role="tablist" (or Radix List that owns it). */
const TABLIST_ALLOWLIST = new Set([
  path.join(ROOT, "src/components/ui/tabs.tsx"),
  path.join(ROOT, "src/components/portal-os/DetailPanelShell.tsx"),
]);

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

// --- 1. Hard-fail: settings-org-select under settings/ ---
const settingsDir = path.join(ROOT, "src/app/(portal)/settings");
const settingsFiles = walkFiles(settingsDir);
const orgSelectHits = [];
for (const file of settingsFiles) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes("settings-org-select")) continue;
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
let shellText = "";
try {
  shellText = fs.readFileSync(shellPath, "utf8");
} catch {
  console.error(
    "✗ eden/chrome-band-markers: ResourcePageShell.tsx not found."
  );
  process.exitCode = 1;
}
if (shellText) {
  const hasIdentity = shellText.includes('data-chrome-band="identity"');
  const hasToolbar = shellText.includes('data-chrome-band="toolbar"');
  if (!hasIdentity || !hasToolbar) {
    // If markers were ever removed again, hard-fail. (Wave 5: markers present.)
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
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
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

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("lint:portal-clutter OK");
