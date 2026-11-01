/**
 * A fingerprint of how the ranker's facts are defined (`decide.ts` `Facts`, and `partner.ts`'s `rank`, `factsOf` and
 * `askFacts`, which compute them), for `rank-weights.json` (docs/research/smart-rank.md). Fitted weights mean
 * something only for the facts they were fitted on: a change to what a fact holds or how it is scaled (`score`,
 * `relScore`, `ageDays`) leaves them wrong with nothing failing. `rank-fit.ts` writes the fingerprint beside the
 * weights and `rank.test.ts` checks it, so such a change fails until the weights are refitted (or the fingerprint is
 * consciously updated, when the change cannot move a fact). Comments and whitespace do not count.
 *
 * Lab and test only: it reads the engine's own source files, never on a request's path.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** A method of a class, from its declaration line to its closing brace at the same indent. */
function method(source: string, name: string): string {
  const start = source.indexOf(`\n  private ${name}(`);
  if (start < 0) throw new Error(`facts fingerprint: no method ${name}`);
  const end = source.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`facts fingerprint: method ${name} has no end`);
  return source.slice(start, end + 4);
}

/** A top-level declaration, from its first line to the line at column 0 that closes it (`close`). */
function block(source: string, head: string, close: string): string {
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`facts fingerprint: no ${head}`);
  const end = source.indexOf(`\n${close}\n`, start);
  if (end < 0) throw new Error(`facts fingerprint: ${head} has no end`);
  return source.slice(start, end + close.length + 1);
}

/** Code without comments or whitespace (a "//" inside a string is rare in these blocks, and always cut alike). */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, "");
}

/** The fingerprint of the facts' definition: 16 hex characters of a SHA-256. */
export function factsFingerprint(): string {
  const decide = readFileSync(new URL("./decide.ts", import.meta.url), "utf8");
  const partner = readFileSync(new URL("./partner.ts", import.meta.url), "utf8");
  const parts = [
    block(decide, "export interface Facts {", "}"),
    block(decide, "export const FACT_NAMES", "];"),
    method(partner, "rank"),
    method(partner, "factsOf"),
    method(partner, "askFacts"),
  ];
  return createHash("sha256").update(parts.map(codeOf).join("\n")).digest("hex").slice(0, 16);
}
