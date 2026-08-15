import { describe, expect, test } from "bun:test";
import { lastOutboxKind, stretchEndForRun } from "./drain";

describe("drain outbox", () => {
  test("stretch_end only when Stop was last for that run", () => {
    const box = [
      JSON.stringify({ run_id: "a", kind: "turn_split", ts: 1 }),
      JSON.stringify({ run_id: "a", kind: "stretch_end", ts: 2 }),
      JSON.stringify({ run_id: "b", kind: "turn_split", ts: 3 }),
    ].join("\n");
    expect(lastOutboxKind(box, "a")).toBe("stretch_end");
    expect(stretchEndForRun(box, "a")).toBe(true);
    expect(stretchEndForRun(box, "b")).toBe(false);
    expect(stretchEndForRun(box, "missing")).toBe(false);
  });
});
