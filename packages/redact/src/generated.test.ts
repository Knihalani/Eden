/**
 * The files this package carries a copy of stay current: `rules.generated.json` (the vendored gitleaks config as JSON
 * and every regex's anchor analysis, written by `generate.ts`) against the TOML and the code, and the matcher it
 * vendors from @eden/primitives (`src/primitives/`) against that package's own, when the package sits beside it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED, generate } from "./generate.ts";

describe("generated and vendored files", () => {
  test("rules.generated.json is what generate.ts writes now (else: bun packages/redact/src/generate.ts)", () => {
    // Compared as text, so a stale analysis, a changed rule or a hand edit all fail here.
    expect(readFileSync(GENERATED, "utf8") === generate()).toBe(true);
  });

  const shared = join(import.meta.dir, "..", "..", "primitives", "src");
  test.skipIf(!existsSync(shared))("the vendored matcher is @eden/primitives' own, byte for byte", () => {
    for (const file of ["matcher.ts", "matcher.reference.ts", "charclass.ts"]) {
      const ours = readFileSync(join(import.meta.dir, "primitives", file), "utf8");
      const theirs = readFileSync(join(shared, file), "utf8");
      expect([file, ours === theirs]).toEqual([file, true]);
    }
  });
});
