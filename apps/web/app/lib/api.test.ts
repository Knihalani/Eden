import { describe, expect, test } from "bun:test";
import { packEdits } from "./api";

describe("packEdits", () => {
  test("omits a no-op payload so approve does not look like a rewrite", () => {
    expect(packEdits("resolve_ticket", "resolve_ticket", [], [], [])).toBeUndefined();
  });

  test("keeps rename and drop", () => {
    expect(packEdits("shipped", "resolve_ticket", ["lookup"], [], [])).toEqual({
      name: "shipped",
      drop: ["lookup"],
    });
  });
});
