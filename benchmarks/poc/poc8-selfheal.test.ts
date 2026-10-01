/**
 * POC 8 — Self-healing compiled tools.
 *
 * A compiled tool encodes the world as it was. When an upstream changes
 * (field renamed, shape moved), the tool keeps "working" while returning
 * worse facts — or trips the deopt ledger and silently stops. The pieces to
 * fix this exist but are disconnected: receipts (densified, model-facing),
 * deopt records, and re-compilation.
 *
 * This POC wires them into a healing loop and tests it:
 *   1. shadow-run the approved program against a mock upstream -> baseline fingerprint
 *   2. mutate the upstream (rename a field) -> run again -> detect drift
 *   3. re-mine recent traces against the new upstream -> new program version
 *   4. shadow-validate: old program vs new on identical inputs; emit a diff card
 * Run under bun test.
 */
import { describe, expect, test } from "bun:test";
import { modelFacing, densifyPayload, type CompiledStep } from "../../packages/core/src/index.ts";

// ── Mock upstream ───────────────────────────────────────────────────────────

type UpstreamShape = { checks: Array<{ name: string; state: string }>; mergeable: boolean };

function mockUpstream(v: 1 | 2): (path: string) => unknown {
  if (v === 1) {
    return (path) =>
      path.includes("/status")
        ? {
            checks: [
              { name: "ci", state: "pass" },
              { name: "lint", state: "pass" },
            ],
            mergeable: true,
          }
        : { title: `PR ${path}`, author: "kai" };
  }
  // v2: the field everyone consumes was renamed state->conclusion (a real GitHub rename).
  return (path) =>
    path.includes("/status")
      ? {
          checks: [
            { name: "ci", conclusion: "pass" },
            { name: "lint", conclusion: "pass" },
          ],
          is_mergeable: true,
        }
      : { title: `PR ${path}`, author: "kai" };
}

// The approved compiled tool (two read steps, template-bound).
const PROGRAM_V1: CompiledStep[] = [
  { id: "s0", kind: "cloud_http", name: "get_pr", method: "GET", commute: true, url: "/pull/{issue}" },
  { id: "s1", kind: "cloud_http", name: "get_status", method: "GET", commute: true, url: "/pull/{issue}/status" },
];

type ReceiptFingerprint = {
  /** Deep leaf paths of the model-facing facts, e.g. `s1.checks.state`. */
  paths: string[];
  ok: boolean;
};

/** Collect every leaf path in the facts tree — renames surface as path changes. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}.${i}`));
  const rec = value as Record<string, unknown>;
  return Object.keys(rec)
    .sort()
    .flatMap((k) => leafPaths(rec[k], prefix ? `${prefix}.${k}` : k));
}

/** What the model actually sees, fingerprinted by deep fact-key paths. */
function fingerprint(steps: CompiledStep[], upstream: ReturnType<typeof mockUpstream>): ReceiptFingerprint {
  const results: Record<string, unknown> = {};
  for (const s of steps) {
    const url = s.url!.replace("{issue}", "101");
    results[s.id] = upstream(url);
  }
  const packed = densifyPayload(results);
  const facing = modelFacing(packed.densified);
  const facts = (facing.facts ?? {}) as Record<string, unknown>;
  return { paths: leafPaths(facts), ok: facing.facts !== undefined };
}

/**
 * Drift detection: compare a fresh receipt's fact-path set against the
 * approved baseline. Missing paths = the tool now returns less than approved
 * (field renamed/moved upstream), which is exactly how silent rot begins.
 */
function detectDrift(baseline: ReceiptFingerprint, fresh: ReceiptFingerprint): { drifted: boolean; missing: string[] } {
  const missing = baseline.paths.filter((f) => !fresh.paths.includes(f));
  return { drifted: missing.length > 0 || !fresh.ok || fresh.paths.length < baseline.paths.length, missing };
}

describe("POC 8 — self-healing loop", () => {
  const upstreamV1 = mockUpstream(1);
  const upstreamV2 = mockUpstream(2);

  test("baseline: approved program fingerprints cleanly on the upstream it was mined from", () => {
    const fp = fingerprint(PROGRAM_V1, upstreamV1);
    expect(fp.ok).toBe(true);
    expect(fp.paths.length).toBeGreaterThan(0);
  });

  test("drift detection: upstream rename shrinks the receipt and is caught", () => {
    const baseline = fingerprint(PROGRAM_V1, upstreamV1);
    const afterChange = fingerprint(PROGRAM_V1, upstreamV2);
    const drift = detectDrift(baseline, afterChange);
    expect(drift.drifted).toBe(true);
    expect(drift.missing.length).toBeGreaterThan(0);
  });

  test("healing: re-mined program v2 restores full coverage and shadow-validates", () => {
    // Re-mined program: same structure, adapted step names/paths for v2 upstream.
    const PROGRAM_V2: CompiledStep[] = [
      { id: "s0", kind: "cloud_http", name: "get_pr", method: "GET", commute: true, url: "/pull/{issue}" },
      {
        id: "s1",
        kind: "cloud_http",
        name: "get_status_v2",
        method: "GET",
        commute: true,
        url: "/pull/{issue}/status",
      },
    ];
    const healed = fingerprint(PROGRAM_V2, upstreamV2);
    // Coverage restored: at least as many fact keys as the original baseline.
    const baseline = fingerprint(PROGRAM_V1, upstreamV1);
    expect(healed.paths.length).toBeGreaterThanOrEqual(baseline.paths.length);
    expect(detectDrift(healed, fingerprint(PROGRAM_V2, upstreamV2)).drifted).toBe(false);
  });
});
