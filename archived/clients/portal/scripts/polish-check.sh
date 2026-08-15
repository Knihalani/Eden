#!/usr/bin/env bash
# ponytail: post-polish invariant checks. Returns non-zero if any
# hardcoded hex, duplicate SeverityBadge def, dead mock array, the
# old logo.svg, an internal-route <a href>, or a dead CSS root
# variable sneaks back in. Run after any UI polish pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ checking for hardcoded hex outside tokens / globals / clerk-theme…"
# The analytics-tab holds a known SSR fallback const (CHART_COLORS_FALLBACK)
# for when window is undefined. BrowserReplayPanel embeds a sandboxed HTML
# shell for the replay iframe (not product chrome). global-error.tsx renders
# its own <html>/<body> to replace a root layout that itself threw, so
# globals.css is not guaranteed to be loaded and inline hex is the only thing
# that can be relied on there. tokens.css is the canonical hex palette —
# every other hex (including composer greys in components.css) should be a
# design token.
#
# Two classes of match are filtered out rather than excluded by filename,
# because excluding whole files would blind the check to real regressions in
# them:
#   - comment lines, which document *why* a colour was removed and would
#     otherwise make writing that rationale down a lint failure;
#   - `|| "#rrggbb"` / `?? "#rrggbb"` fallback literals, which are by
#     definition only reached when a token lookup returned nothing (see
#     gateway-client.tsx reading getPropertyValue("--bg")) — a token cannot
#     be its own fallback.
HEX_MATCHES=$(grep -rEn '#[0-9a-fA-F]{6}' src/app src/components src/styles 2>/dev/null \
  | grep -v 'globals.css' | grep -v 'clerk-theme.ts' \
  | grep -v 'tokens.css' \
  | grep -v 'analytics-tab.tsx' \
  | grep -v 'BrowserReplayPanel.tsx' \
  | grep -v 'global-error.tsx' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
  | grep -vE '(\|\||\?\?)[[:space:]]*"#[0-9a-fA-F]{6}"' \
  || true)
if [ -n "$HEX_MATCHES" ]; then
  echo "$HEX_MATCHES"
  echo "✗ hardcoded hex found (see above)"
  exit 1
fi

# Canonical home for shared status/severity chips. This was
# src/components/ui/status-badge.tsx until 9a1452b4 ("complete live API
# wire-up") deleted that file and moved SeverityBadge into lab-ui.tsx; the
# two rules below kept pointing at the old path, so they flagged the one
# canonical definition as a duplicate and this script has failed on every
# run since. Keep this in step with wherever the chips actually live.
BADGE_HOME='src/lab/lab-ui.tsx'

echo "→ checking for local SeverityBadge defs (should only live in ${BADGE_HOME})…"
if grep -rn 'function SeverityBadge' src 2>/dev/null \
  | grep -v "$BADGE_HOME"; then
  echo "✗ duplicate SeverityBadge def found"
  exit 1
fi

echo "→ checking for local IssuePriorityBadge / IssueSeverityBadge defs…"
if grep -rn 'function IssuePriorityBadge\|function IssueSeverityBadge' src 2>/dev/null \
  | grep -v "$BADGE_HOME" \
  | grep -v '__tests__'; then
  echo "✗ duplicate issue priority badge def found"
  exit 1
fi

echo "→ checking for old logo.svg…"
if [ -f public/logo.svg ]; then
  echo "✗ public/logo.svg should be deleted (use logo.png)"
  exit 1
fi

echo "→ checking for unused MOCK_INJECTIONS / MOCK_PII_REDACTIONS…"
# Skip comment lines — the replacement-of-mock comments in guardrails and
# lib/api.ts are intentional documentation.
MATCHES=$(grep -rn 'MOCK_INJECTIONS\|MOCK_PII_REDACTIONS' src 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  CODE_MATCHES=$(echo "$MATCHES" | grep -vE '^[^:]+:[0-9]+:\s*(//|\*|/\*)' || true)
  if [ -n "$CODE_MATCHES" ]; then
    echo "✗ dead mock arrays found:"
    echo "$CODE_MATCHES"
    exit 1
  fi
fi

echo "→ checking for internal-route <a href> in marketing/legal/docs…"
# Internal routes (anything starting with / but not //, mailto:, tel:,
# http://, https://, /#, or /api/ + same-origin subroutes) should use
# next/link so the click is client-side and gets the prefetch + a11y
# benefits. /api/ routes get a pass because they're absolute URLs that
# always need a full reload.
if grep -rEn '<a[[:space:]]+href="/[a-z]' \
    src/app/'(marketing)' src/app/docs 2>/dev/null \
  | grep -v 'mailto:'; then
  echo "✗ internal-route <a href> found (use next/link)"
  exit 1
fi

echo "→ checking for dead root CSS variables in globals.css…"
python3 <<'PYDEAD'
import re
import sys

with open("src/app/globals.css") as f:
    css = f.read()

# Pull :root tokens.
root = re.search(r":root\s*\{(.+?)^\}", css, re.DOTALL | re.MULTILINE)
root_block = root.group(1) if root else ""
root_tokens = set(re.findall(r"^\s*(--[a-z][a-z0-9-]*):", root_block, re.MULTILINE))

# A root token is "live" if:
#  - referenced via var(--name) anywhere in globals.css (including
#    inside :root, @theme, base styles, animations, etc.), OR
#  - bridged via @theme (LHS declared so Tailwind utility works).
# All var(--name) refs anywhere in src/ (excluding globals.css itself).
import subprocess
g = subprocess.run(
    ["grep", "-rE", r"var\(--[a-z]", "src/", "--exclude=globals.css"],
    capture_output=True, text=True,
)
live_in_src = set()
for line in g.stdout.splitlines():
    live_in_src.update(re.findall(r"var\((--[a-z][a-z0-9-]*)\)", line))
live_in_globals = set(re.findall(r"var\((--[a-z][a-z0-9-]*)\)", css)) | live_in_src

theme_block = re.search(
    r"@theme\s+(?:inline\s+)?\{(.+?)^\}", css, re.DOTALL | re.MULTILINE
)
theme_lhs = set(re.findall(
    r"^\s*(--[a-z][a-z0-9-]*):",
    theme_block.group(1) if theme_block else "",
    re.MULTILINE,
))

# Tokens whose names are font aliases bridged through Tailwind theme.
font_aliases = {"font-sans", "font-mono", "font-display"}

# Shadcn compatibility aliases — kept on purpose for third-party
# shadcn snippets (see the docblock at the top of globals.css).
compat_aliases = {"background", "foreground", "surface", "surface-elevated"}

# Reserved design-system tokens (declared for clerk-theme / type scale /
# semantic pairs). Not yet referenced via var(--*) in product TSX; keep
# them so Wave 4+ migrations can adopt without re-adding CSS. Do not
# expand this set casually — prefer wiring a real var(--*) consumer.
reserved_tokens = {
    "cat-danger-dim",
    "cat-danger-fg",
    "cat-success-fg",
    "cat-warning-dim",
    "cat-warning-fg",
    "info-bg",
    "letter-spacing-tight",
    "letter-spacing-wide",
}

dead = []
for t in sorted(root_tokens):
    name = t[2:]
    if name in compat_aliases:
        continue
    if name in reserved_tokens:
        continue
    if t in live_in_globals:
        continue
    if t in theme_lhs:
        continue
    if name in font_aliases:
        continue
    dead.append(name)

if dead:
    for name in dead:
        print(f"  dead root token: --{name}")
    print(f"\n✗ {len(dead)} dead root tokens in globals.css")
    sys.exit(1)
PYDEAD

echo "→ checking for body overflow-x: hidden (breaks position: sticky)…"
# ``overflow-x: hidden`` on body cascades to ``overflow-y: auto``,
# which makes body a scroll container. position: sticky inside
# body then pins to body, not the viewport — sidebar / TOC /
# page headers silently scroll out of view. Use ``overflow-x:
# clip`` (same visual effect, no scroll context) or move the
# horizontal clamp onto the offending child instead.
if grep -nE "^[[:space:]]*overflow-x:[[:space:]]*hidden;" src/app/globals.css; then
  echo "✗ body overflow-x: hidden found — use overflow-x: clip instead"
  exit 1
fi

echo "→ checking that html has overflow-y: auto somewhere in globals.css…"
# Without this, the html element defaults to overflow: visible
# and a tall page doesn't scroll. Document scroll is required
# for sticky elements to work in the html-scroll model.
if ! grep -qE "overflow-y:[[:space:]]*auto" src/app/globals.css; then
  echo "✗ html overflow-y: auto not declared in globals.css"
  exit 1
fi

echo "→ lint:portal-layout (viewport height ban)…"
node scripts/lint-portal-layout.cjs

echo "→ lint:portal-classes (colors + Wave 4/5 spacing/type ratchets)…"
node scripts/lint-portal-classes.cjs

echo "→ lint:portal-clutter (Wave 5 anti-clutter gates)…"
node scripts/lint-portal-clutter.cjs

echo "✓ all polish invariants pass"
