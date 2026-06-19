#!/usr/bin/env node
// ponytail: flag hardcoded colors anywhere in (portal) or shared
// components. The portal uses CSS variables (--bg-primary, --accent,
// etc.) so a dark/light theme swap propagates everywhere. Hardcoded
// `text-white`, `bg-black`, `text-gray-*` etc. break the design
// system. Use the variables instead.

const { execSync } = require("node:child_process");
const PATTERN = "text-white|bg-black|text-gray-|text-blue-|bg-blue-";
let hits;
try {
  hits = execSync(
    `grep -rE "${PATTERN}" "src/app/(portal)/" "src/components/" 2>/dev/null || true`,
    { encoding: "utf8" }
  );
} catch (e) {
  hits = "";
}
if (hits.trim()) {
  console.error(
    "Use CSS variables, not hardcoded colors. Replace text-white/bg-black/text-gray-*/text-blue-*/bg-blue-* with bg-[var(--bg-*)]/text-[var(--text-*)]/border-[var(--border-*)].\n" +
      hits
  );
  process.exit(1);
}
console.log("lint:portal-classes OK");
