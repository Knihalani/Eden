/**
 * Publication checklist (ROADMAP R3). Fail closed: a leak of uncertified
 * savings, analogue cents as live Claude Code, or oblivious-long as a win
 * is a red test, not a wording nit.
 */
import { existsSync, readFileSync } from "node:fs";
import { PUBLIC_CLAIMS } from "./claims";

export type PublishFinding = { file: string; line: number; rule: string; excerpt: string };

/** Public copy a critic can open. Missing files are skipped until the wave lands them. */
export const PUBLIC_COPY_PATHS = [
  "docs/whitepaper.md",
  "docs/cases.md",
  "docs/ROADMAP.md",
  "docs/isolation.md",
  "docs/marketplace-draft.md",
  "benchmarks/campaign/README.md",
  "benchmarks/campaign/SILENT-DROP.md",
  "benchmarks/campaign/LIVE-AB.md",
  "benchmarks/campaign/HOST-DROP.md",
  "benchmarks/campaign/JIT-SOAK.md",
  "benchmarks/campaign/OBLIVIOUS-LONG.md",
  "benchmarks/campaign/WITNESS-ECON.md",
  "apps/web/app/(notes)/proof/copy.ts",
  "apps/web/app/(notes)/proof/page.tsx",
  "apps/web/app/(notes)/isolation/copy.ts",
  "apps/web/app/landing/hero.tsx",
  "apps/web/app/landing/close.tsx",
  "packages/measure/src/claims.ts",
  "packages/cli/src/digest.ts",
  "packages/measure/src/digest.ts",
];

const WIN_IDS = new Set(PUBLIC_CLAIMS.filter((c) => c.kind === "win").map((c) => c.id));

const INVOICE_DISCLAIMER =
  /not a live|retired|no live Claude Code invoice|this quote is retired|missing invoice|^\s*name:|id:\s*"s1b-live-invoice"/i;

export function scanPublicText(file: string, text: string): PublishFinding[] {
  const findings: PublishFinding[] = [];
  const lines = text.split(/\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    const l = line;
    if (
      /UNCERTIFIED/i.test(l) &&
      /win|×|cheaper|savings/i.test(l) &&
      !/never|not a win|retires|badge|until|marked|published metric|closes the loop/i.test(l)
    ) {
      findings.push({ file, line: n, rule: "uncertified-as-win", excerpt: l.trim() });
    }
    if (
      /live Claude Code/i.test(l) &&
      /(TURN_CENTS|ISLAND_CENTS|−9\.1%|−9\.09%)/i.test(l) &&
      !/not a live|cannot be quoted|retired|cannot ack/i.test(l)
    ) {
      findings.push({ file, line: n, rule: "analogue-as-live", excerpt: l.trim() });
    }
    if (
      /analogue/i.test(l) &&
      /\bWIN\b/i.test(l) &&
      /(−9\.1%|−9\.09%|TURN_CENTS)/i.test(l) &&
      !/not a win|limit|retired|not a campaign/i.test(l)
    ) {
      findings.push({ file, line: n, rule: "analogue-as-win", excerpt: l.trim() });
    }
    if (/oblivious-long/i.test(l) && /\bWIN\b/i.test(l) && !/not a win|limit|loss|retired/i.test(l)) {
      findings.push({ file, line: n, rule: "oblivious-as-win", excerpt: l.trim() });
    }
    if (
      /host-drop/i.test(l) &&
      /live Claude Code/i.test(l) &&
      /ack/i.test(l) &&
      !/cannot|never|limit|replica-only/i.test(l)
    ) {
      findings.push({ file, line: n, rule: "replica-drop-as-live-ack", excerpt: l.trim() });
    }
    if (/(billed S1b|live Claude Code invoice)/i.test(l) && !INVOICE_DISCLAIMER.test(l)) {
      findings.push({ file, line: n, rule: "billed-s1b-invoice", excerpt: l.trim() });
    }
    if (/(−9\.1%|-9\.1%)/.test(l) && !/analogue/i.test(l) && !/retired/i.test(l)) {
      findings.push({ file, line: n, rule: "unlabeled-analogue", excerpt: l.trim() });
    }
  });
  return findings;
}

export function scanPublicFiles(paths: string[], opts?: { missing?: "skip" | "find" }): PublishFinding[] {
  const missing = opts?.missing ?? "find";
  const out: PublishFinding[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      if (missing === "find") out.push({ file: p, line: 0, rule: "missing-file", excerpt: p });
      continue;
    }
    out.push(...scanPublicText(p, readFileSync(p, "utf8")));
  }
  return out;
}

export function winTableHas(id: string): boolean {
  return WIN_IDS.has(id);
}
