/**
 * Writes `rules.generated.json`: the vendored gitleaks config (`vendor/gitleaks/gitleaks.toml` as JSON, so the gate
 * imports it on any runtime; Node has no TOML import) and the anchor analyses of every regex the gate runs on
 * JavaScript's engine (anchor.ts: `anchorsOf`, `lazyPrefixOf`), so the first call parses no rule. `generated.test.ts`
 * regenerates it in memory and fails when the committed file differs. Run after vendoring a gitleaks release or
 * changing one of Eden's regexes or the analysis:
 *
 *   bun packages/redact/src/generate.ts
 *
 * Bun only (it imports the TOML); the gate itself does not need it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Analyses, analyseAnchors, analyseLazy, goPatternOfRegex } from "./anchor.ts";
import { checkAllowlists, EDEN_REGEXES, goRegex, LAZY_PREFIX, LINEAR_RULES } from "./secrets.ts";
import gitleaks from "./vendor/gitleaks/gitleaks.toml";

export const GENERATED = join(import.meta.dir, "rules.generated.json");
const TOML = join(import.meta.dir, "vendor", "gitleaks", "gitleaks.toml");

/** The file's content, worked out now from the TOML and the code (never from the committed file). */
export function generate(): string {
  const config = gitleaks as { rules: Parameters<typeof checkAllowlists>[0] };
  checkAllowlists(config.rules);
  const analyses: Analyses = { anchors: {}, lazy: {} };
  for (const rule of config.rules) {
    // The scanned rules run on their own matchers (scanners.ts) and are never anchored.
    if (!rule.regex || LINEAR_RULES.has(rule.id)) continue;
    const lazy = LAZY_PREFIX.test(rule.regex) ? analyseLazy(rule.regex, goRegex(rule.regex)) : undefined;
    if (lazy !== undefined) analyses.lazy[rule.regex] = lazy;
    // A lazy-prefix rule's anchors too: on a short text it tries its regex where they allow (D1850 (12)).
    analyses.anchors[rule.regex] = analyseAnchors(rule.regex);
  }
  for (const regex of EDEN_REGEXES) {
    const pattern = goPatternOfRegex(regex);
    analyses.anchors[pattern] = analyseAnchors(pattern);
  }
  const sha256 = createHash("sha256").update(readFileSync(TOML)).digest("hex");
  const file = { generatedBy: "packages/redact/src/generate.ts", gitleaksSha256: sha256, gitleaks: config, analyses };
  // Descriptions and tags are prose the gate never reads.
  return `${JSON.stringify(file, (key, value) => (key === "description" || key === "tags" ? undefined : value), 1)}\n`;
}

if (import.meta.main) {
  writeFileSync(GENERATED, generate());
  console.log(`wrote ${GENERATED}`);
}
