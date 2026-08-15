#!/usr/bin/env node
// Portal class lint gates.
//
// Existing: flag hardcoded colors anywhere in (portal) or shared
// components. The portal uses CSS variables (--bg-primary, --accent,
// etc.) so a dark/light theme swap propagates everywhere. Hardcoded
// `text-white`, `bg-black`, `text-gray-*` etc. break the design
// system. Use the variables instead.
//
// Wave 4 (w3-spacing-tokens.md §7): ratchet gates that fail only when
// counts INCREASE vs the stored baseline. Do not hard-fail the huge
// existing baseline — ratchet down per PR as migrations land.
//
// Wave 5 (w5-lint-gates): ratcheted after foundation purge (re-measured
// 2026-07-20 with the same walk logic over clients/portal/src, excl. tests).
// Wave 13–15 ratchets (re-measured 2026-07-20; W15 locks post-interaction floor):
//   MICRO_TEXT   91  — text-[9|10|11px] (was 112 → 96 → 91)
//   HALF_STEP   112  — \b(py|px|gap|p|m)-0.5\b (was 139 → 138 → 121 → 112)
//   ACCENT_CTA    2  — raw <button … bg-[var(--accent)] opening tags (was 6)
// Wave 1 V2 kit freeze (2026-07-21): MICRO_TEXT 91→79
// Wave 6 Home shell buttons (2026-07-21): ACCENT_CTA 2→1; chrome path hard-fail

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

// Wave 1 V2 kit freeze baselines (occurrence counts; raise only if intentional) ---
const BASELINE_MICRO_TEXT = 79;
const BASELINE_HALF_STEP = 112;
const BASELINE_ACCENT_CTA = 1;

const MICRO_TEXT_RE = /text-\[(?:9|10|11)px\]/g;
const HALF_STEP_RE = /\b(?:py|px|gap|p|m)-0\.5\b/g;
const ACCENT_IN_TAG_RE = /bg-\[var\(--accent\)\]/;

/** Shell Home path — zero hand-rolled accent buttons (W6). */
const SHELL_ACCENT_BAN_PATHS = [
  path.join(ROOT, "src/components/portal-chrome"),
  path.join(ROOT, "src/components/cookie-consent.tsx"),
  path.join(
    ROOT,
    "src/app/(portal)/dashboard/_components/home-header-actions.tsx"
  ),
];

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

function walkFiles(dir, out = []) {
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
      walkFiles(full, out);
    } else if (ent.isFile()) {
      if (!/\.(tsx?|jsx?|css|mdx)$/.test(ent.name)) continue;
      if (isTestFile(full)) continue;
      out.push(full);
    }
  }
  return out;
}

function collectShellFiles() {
  const out = [];
  for (const p of SHELL_ACCENT_BAN_PATHS) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, out);
    else if (st.isFile() && !isTestFile(p)) out.push(p);
  }
  return out;
}

function countOccurrences(files, regex) {
  let total = 0;
  const samples = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const re = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : `${regex.flags}g`
    );
    let match;
    while ((match = re.exec(text)) !== null) {
      total += 1;
      if (samples.length < 8) {
        const line = text.slice(0, match.index).split("\n").length;
        samples.push(`${path.relative(ROOT, file)}:${line}: ${match[0]}`);
      }
    }
  }
  return { total, samples };
}

/** Opening <button> tags that include bg-[var(--accent)] (multiline-safe). */
function countAccentCtaButtons(files) {
  let total = 0;
  const samples = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      const start = lower.indexOf("<button", i);
      if (start < 0) break;
      const after = start + 7;
      if (text[after] && /[a-zA-Z0-9]/.test(text[after])) {
        i = after;
        continue;
      }
      let j = after;
      let quote = null;
      while (j < text.length && j - start < 4000) {
        const c = text[j];
        if (quote) {
          if (c === quote && text[j - 1] !== "\\") quote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          quote = c;
        } else if (c === ">") {
          break;
        }
        j += 1;
      }
      const tag = text.slice(start, j + 1);
      if (ACCENT_IN_TAG_RE.test(tag)) {
        total += 1;
        if (samples.length < 8) {
          const line = text.slice(0, start).split("\n").length;
          const compact = tag.replace(/\s+/g, " ").slice(0, 100);
          samples.push(`${path.relative(ROOT, file)}:${line}: ${compact}`);
        }
      }
      i = j + 1;
    }
  }
  return { total, samples };
}

function failRatchet(name, count, baseline, samples, hint) {
  console.error(
    `✗ ${name}: count ${count} exceeds baseline ${baseline} (+${count - baseline}).\n` +
      `  ${hint}\n` +
      (samples.length ? `  samples:\n    ${samples.join("\n    ")}\n` : "") +
      `  Lower the count or, if intentional, raise BASELINE_* in scripts/lint-portal-classes.cjs.`
  );
  process.exitCode = 1;
}

// --- 1. Hardcoded color ban (hard fail) ---
const COLOR_PATTERN = "text-white|bg-black|text-gray-|text-blue-|bg-blue-";
let colorHits;
try {
  colorHits = execSync(
    `grep -rE "${COLOR_PATTERN}" "src/app/(portal)/" "src/components/" 2>/dev/null || true`,
    { encoding: "utf8", cwd: ROOT }
  );
} catch {
  colorHits = "";
}
if (colorHits.trim()) {
  console.error(
    "Use CSS variables, not hardcoded colors. Replace text-white/bg-black/text-gray-*/text-blue-*/bg-blue-* with bg-[var(--bg-*)]/text-[var(--text-*)]/border-[var(--border-*)].\n" +
      colorHits
  );
  process.exit(1);
}

// --- 2–4. Wave 4/5 ratchets over src/ (excl. tests) ---
const srcFiles = walkFiles(path.join(ROOT, "src"));

const micro = countOccurrences(srcFiles, MICRO_TEXT_RE);
if (micro.total > BASELINE_MICRO_TEXT) {
  failRatchet(
    "eden/no-arbitrary-micro-text",
    micro.total,
    BASELINE_MICRO_TEXT,
    micro.samples,
    "Prefer text-xs / text-2xs / text-3xs over text-[9|10|11px] (w3-spacing-tokens.md §7)."
  );
} else {
  console.log(
    `lint:portal-classes micro-text OK (${micro.total}/${BASELINE_MICRO_TEXT})`
  );
}

const half = countOccurrences(srcFiles, HALF_STEP_RE);
if (half.total > BASELINE_HALF_STEP) {
  failRatchet(
    "eden/no-off-grid-half",
    half.total,
    BASELINE_HALF_STEP,
    half.samples,
    "Prefer on-grid spacing (*-1 / *-2 / --space-*) over *-0.5 (w3-spacing-tokens.md §7)."
  );
} else {
  console.log(
    `lint:portal-classes half-step OK (${half.total}/${BASELINE_HALF_STEP})`
  );
}

const accent = countAccentCtaButtons(srcFiles);
if (accent.total > BASELINE_ACCENT_CTA) {
  failRatchet(
    "eden/no-raw-accent-button",
    accent.total,
    BASELINE_ACCENT_CTA,
    accent.samples,
    'Use <Button variant="default"> (or design-system CTA) instead of raw <button className="… bg-[var(--accent)]">.'
  );
} else {
  console.log(
    `lint:portal-classes accent-cta OK (${accent.total}/${BASELINE_ACCENT_CTA})`
  );
}

// --- 5. Wave 6: shell Home path — hard fail any raw accent button ---
const shellAccent = countAccentCtaButtons(collectShellFiles());
if (shellAccent.total > 0) {
  console.error(
    `✗ eden/no-shell-raw-accent-button: ${shellAccent.total} hand-rolled accent <button> in shell Home path.\n` +
      `  Use kit <Button variant="default"> — portal-chrome/, cookie-consent, home-header-actions.\n` +
      (shellAccent.samples.length
        ? `  samples:\n    ${shellAccent.samples.join("\n    ")}\n`
        : "")
  );
  process.exitCode = 1;
} else {
  console.log("lint:portal-classes shell-accent OK (0)");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("lint:portal-classes OK");
