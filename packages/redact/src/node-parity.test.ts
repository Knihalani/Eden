/**
 * The gate on Node finds what it finds on Bun: the same rule ids and spans, hits, stored text and redaction, text for
 * text, on seeded fuzz texts (every rule's regex sampled, Eden's shapes, the characters engines disagree on) and the
 * crafted inputs. Node runs `node-parity.ts`. The Node used is `REDACT_NODE`, else `node` on the PATH; one older than
 * 24 must refuse to build the gate (its RegExp modifiers are missing or wrong, and gitleaks' rules use them), and the
 * comparison is skipped. Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prng } from "./differential.ts";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { gateText } from "./gate-differential.ts";
import { verdicts } from "./node-parity.ts";

const NODE = process.env.REDACT_NODE ?? "node";
const version = spawnSync(NODE, ["--version"], { encoding: "utf8" });
const major = version.status === 0 ? Number(/^v(\d+)/.exec(version.stdout)?.[1] ?? 0) : 0;
const SCRIPT = join(import.meta.dir, "node-parity.ts");

/** Runs `node-parity.ts` on Node over `texts`. */
function onNode(texts: string[]): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "redact-parity-"));
  try {
    const input = join(dir, "texts.json");
    writeFileSync(input, JSON.stringify(texts));
    return spawnSync(NODE, [SCRIPT, input], { encoding: "utf8", maxBuffer: 256 << 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the gate on Node", () => {
  test.skipIf(major === 0 || major >= 24)("a Node older than 24 refuses to build it, never misses quietly", () => {
    const run = onNode(["the staging password is hunter22"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("needs RegExp modifiers");
  });

  test.skipIf(major < 24)(
    "finds what Bun finds on 3,000 fuzz texts and the crafted inputs",
    () => {
      const rnd = prng(20261115);
      const texts = Array.from({ length: 3_000 }, () => gateText(rnd));
      for (const [, unit] of CRAFTED_UNITS) texts.push(crafted(unit, 4_096));
      const run = onNode(texts);
      expect(run.stderr).toBe("");
      const node = JSON.parse(run.stdout) as unknown[];
      const bun = verdicts(texts);
      const differ = texts.filter((_, i) => JSON.stringify(node[i]) !== JSON.stringify(bun[i]));
      expect(differ.slice(0, 3)).toEqual([]);
    },
    60_000,
  );
});
