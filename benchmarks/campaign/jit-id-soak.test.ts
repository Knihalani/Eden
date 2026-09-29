/**
 * Hold-out JIT soaks — worlds that did not inform github/kubectl/desk.
 *
 *   bun test benchmarks/campaign/jit-id-soak.test.ts
 *   bun test benchmarks/campaign/jit-cli-soak.test.ts  (this file covers all three)
 */
import { describe, expect, test } from "bun:test";
import { rankPrograms } from "@eden/wrap";
import { soakProg } from "./jit-holdout-lib";
import { runJitIdSoak, idSoakTurns, PROGRAMS as ID_PROGRAMS } from "./jit-id-soak";
import { runJitCliSoak, cliSoakTurns } from "./jit-cli-soak";
import { runJitUrlSoak, urlSoakTurns } from "./jit-url-soak";

function assertPass(
  r: ReturnType<typeof runJitIdSoak>,
  turns: { label: string }[],
) {
  expect(r.uniqueWorkSchemas).toBe(0);
  expect(r.vagueSchemas).toBe(0);
  expect(r.crossHits).toBe(0);
  expect(r.n).toBe(turns.length);
  expect(r.pass).toBe(true);
  expect(r.precision).toBeGreaterThanOrEqual(0.95);
  expect(r.lines.some((l) => l.startsWith("verdict=PASS"))).toBe(true);
}

describe("Wave 22.2 JIT hold-out soaks", () => {
  test("id/URI soak: precision ≥ 0.95; unique-work and vague stay empty", () => {
    assertPass(runJitIdSoak(), idSoakTurns());
  });

  test("CLI soak: terraform/helm/gh/redis/cargo/npm/az/gcloud/aws — not kubectl", () => {
    const labels = cliSoakTurns().map((t) => t.label);
    expect(labels).not.toContain("kubectl");
    expect(labels).not.toContain("psql");
    assertPass(runJitCliSoak(), cliSoakTurns());
  });

  test("URL soak: gitlab/bitbucket/jira/pd/datadog — not api.github.com", () => {
    const labels = urlSoakTurns().map((t) => t.label);
    expect(labels).not.toContain("gh");
    for (const t of urlSoakTurns()) {
      const text = JSON.stringify(t.messages);
      expect(text).not.toContain("api.github.com");
    }
    assertPass(runJitUrlSoak(), urlSoakTurns());
  });

  test("each id-soak label is a different morphology", () => {
    const labels = idSoakTurns().map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("gh");
    expect(labels).not.toContain("kubectl");
    expect(labels).not.toContain("name-only");
  });

  test("rankPrograms on a populated catalog stays cheap", () => {
    const turn = idSoakTurns()[0]!;
    const catalog = [
      ...ID_PROGRAMS,
      ...Array.from({ length: 180 }, (_, i) =>
        soakProg({
          name: `filler_${i}`,
          seq: [`tool_${i}`],
          envelope: { id: [`Z-${1000 + i}`] },
        }),
      ),
    ];
    const t0 = performance.now();
    for (let i = 0; i < 80; i++) rankPrograms(turn.messages, catalog);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(400);
  });
});
