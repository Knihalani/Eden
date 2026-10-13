/**
 * `eden memory extract --jsonl -` (P2.1): the entry point the `extraction` arm drives (A5 E3). One `{id, text}` line
 * in, one `{id, records}` line out, records in the arm's contract shape.
 */
import { describe, expect, test } from "bun:test";
import { extractJsonl } from "./memory-extract";

const run = (rows: unknown[]) =>
  extractJsonl(rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: unknown; records: Record<string, unknown>[] });

describe("eden memory extract --jsonl -", () => {
  test("answers every line with its id and its records", () => {
    const out = run([
      { id: 0, text: "don't open the PR yet" },
      { id: 1, text: "never merge PRs yourself" },
      { id: 2, text: "fix the failing test" },
    ]);
    expect(out).toEqual([
      { id: 0, records: [{ kind: "intent", class: "review", polarity: "neg", object: "*", qualifier: "yet" }] },
      { id: 1, records: [{ kind: "policy", class: "integrate", polarity: "neg", object: "*" }] },
      { id: 2, records: [] },
    ]);
  });

  test("strips pasted spans first (D12), and answers a line it cannot read with no records", () => {
    const out = run([{ id: "a", text: "```\nnever push to main\n```\nwhat is this?" }, { id: 7 }]);
    expect(out).toEqual([
      { id: "a", records: [] },
      { id: 7, records: [] },
    ]);
  });
});

describe("eden memory extract --jsonl -: slot records (P3.3, D7)", () => {
  test("a slot statement answers `{kind: slot, slot, op, value}`, a set and each value it invalidates", () => {
    const out = run([
      { id: 0, text: "use biome for formatting, not prettier" },
      { id: 1, text: "we don't use yarn anymore" },
      { id: 2, text: "the auth is broken" },
    ]);
    expect(out).toEqual([
      {
        id: 0,
        records: [
          { kind: "slot", slot: "formatter", op: "set", value: "biome" },
          { kind: "slot", slot: "formatter", op: "invalidate", value: "prettier" },
        ],
      },
      { id: 1, records: [{ kind: "slot", slot: "pkg.manager", op: "invalidate", value: "yarn" }] },
      { id: 2, records: [] },
    ]);
  });

  test("a slot statement inside a pasted span is stripped first (D12)", () => {
    const out = run([{ id: 0, text: "<pasted_content id=1>\nwe use pnpm here\n</pasted_content id=1>\nthoughts?" }]);
    expect(out).toEqual([{ id: 0, records: [] }]);
  });
});
