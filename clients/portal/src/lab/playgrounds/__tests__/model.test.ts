import { describe, expect, it } from "vitest";

import {
  hubRowToPlaygroundRow,
  parsePlaygroundConfig,
  playgroundRowsToRunPayload,
  serializePlaygroundConfig,
} from "../model";

describe("hubRowToPlaygroundRow", () => {
  it("prefers top-level input and expected_output", () => {
    expect(
      hubRowToPlaygroundRow({
        id: "r1",
        input: "hello",
        expected_output: "world",
        values: { input: "ignored" },
      }),
    ).toEqual({ id: "r1", input: "hello", expected: "world" });
  });

  it("falls back to values map", () => {
    expect(
      hubRowToPlaygroundRow({
        id: "r2",
        values: { input: "from values", expected_output: "exp" },
      }),
    ).toEqual({ id: "r2", input: "from values", expected: "exp" });
  });
});

describe("playgroundRowsToRunPayload", () => {
  it("maps editor rows to run dataset_rows", () => {
    expect(
      playgroundRowsToRunPayload([
        { id: "hub-1", input: "a", expected: "b" },
        { input: "c" },
      ]),
    ).toEqual([
      { id: "hub-1", input: "a", expected_output: "b" },
      { id: "row_1", input: "c" },
    ]);
  });
});

describe("parsePlaygroundConfig dataset_id", () => {
  it("round-trips dataset_id and row ids", () => {
    const view = parsePlaygroundConfig({
      tasks: [],
      dataset_id: "ds_abc",
      rows: [{ id: "r1", input: "x", expected: "y" }],
    });
    expect(view.datasetId).toBe("ds_abc");
    expect(view.rows[0]).toMatchObject({ id: "r1", input: "x", expected: "y" });

    const serialized = serializePlaygroundConfig(view);
    expect(serialized.dataset_id).toBe("ds_abc");
    expect(serialized.rows).toEqual([
      { id: "r1", input: "x", expected: "y" },
    ]);
  });
});
