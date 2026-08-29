/**
 * Wave 4.1 CI gate. Any red cell is a bug — pin a repro, do not loosen the assertion.
 */
import { describe, expect, test } from "bun:test";
import { cellLabel, cornerCells, interiorCells, runCell } from "./concurrency-matrix";

const TIMEOUT = 180_000;

describe("concurrency matrix (Wave 4.1)", () => {
  const cells = [...cornerCells(), ...interiorCells()];
  test(`grid ${cells.length} cells — exactly-once everywhere`, async () => {
    const red: string[] = [];
    for (const cell of cells) {
      const r = await runCell(cell);
      if (!r.ok) red.push(`${cellLabel(cell)} dups=${r.duplicates.join(",")}`);
    }
    expect(red).toEqual([]);
  }, TIMEOUT);
});
