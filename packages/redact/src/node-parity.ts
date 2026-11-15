/**
 * Test support for `node-parity.test.ts`, run by Node: reads a JSON array of texts from the file named by its
 * argument and writes, per text, what the gate makes of it (rule ids and spans, `secretHits`, `sanitizeForStore`,
 * `redactString`) as one JSON array on stdout. Bun runs the same function and the test compares.
 */
import { readFileSync } from "node:fs";
import { redactString } from "./redact.ts";
import { gateOf, secretRules } from "./secrets.ts";

export function verdicts(texts: string[]): unknown[] {
  const gate = gateOf(secretRules());
  return texts.map((text) => [
    gate.findings(text),
    gate.secretHits(text),
    gate.sanitizeForStore(text),
    redactString(text),
  ]);
}

if (process.argv[1] === import.meta.filename) {
  const texts = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as string[];
  process.stdout.write(JSON.stringify(verdicts(texts)));
}
