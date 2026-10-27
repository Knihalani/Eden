import { describe, expect, test } from "bun:test";
import {
  isHostDrop,
  isRemainderSkip,
  isServedHead,
  stretchHead,
  stretchLine,
  stretchSentence,
  stretchWords,
  stretchWordsByTool,
} from "./stretch";

const SERVE = { tool_id: "wf_1", created_at: 1, ok: 1, tokenClass: "transparent", outcome: "ok" };
const SKIP = { tool_id: "wf_1", created_at: 2, ok: 1, tokenClass: "steered-skip", skipped: ["Grep"] };
const DROP = {
  tool_id: "wf_1",
  created_at: 3,
  ok: 1,
  outcome: "degraded",
  reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
};

describe("stretch words", () => {
  test("a 3-call serve + skip + drop is not merely Skipped when the latest row is skip", () => {
    const receipts = [SERVE, DROP, SKIP];
    expect(stretchWords(receipts)).toEqual(["Served", "Skipped", "Degraded"]);
    expect(stretchLine("live", stretchWords(receipts))).toBe("Live · Served · Skipped · Degraded");
    expect(stretchLine("canary", stretchWords(receipts))).toBe("Canary · Served · Skipped · Degraded");
    expect(stretchHead("live", "canary")).toBe("canary");
    expect(stretchHead("paused", "canary")).toBe("paused");
    expect(stretchHead("live")).toBe("live");
    expect(stretchLine("live", stretchWords([SKIP]))).toBe("Live · Skipped");
    expect(stretchLine("paused", stretchWords([DROP]))).toBe("Paused · Degraded");
  });

  test("host-drop on a skip row still names Degraded", () => {
    const both = {
      tool_id: "wf_1",
      ok: 1,
      skipped: ["Read"],
      outcome: "degraded",
      reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
    };
    expect(isHostDrop(both)).toBe(true);
    expect(isRemainderSkip(both)).toBe(true);
    expect(stretchWords([SERVE, both])).toEqual(["Served", "Skipped", "Degraded"]);
  });

  test("transparent head is Served; frontier-only is not", () => {
    expect(isServedHead(SERVE)).toBe(true);
    expect(isServedHead({ ok: 1, tokenClass: "compiled" })).toBe(true);
    expect(isServedHead({ ok: 1, tokenClass: "frontier" })).toBe(false);
    expect(isServedHead(SKIP)).toBe(false);
  });

  test("by-tool grouping does not leak a drop from another tool", () => {
    const map = stretchWordsByTool([
      SERVE,
      SKIP,
      DROP,
      { tool_id: "wf_ok", created_at: 9, ok: 1, tokenClass: "compiled", outcome: "ok" },
    ]);
    expect(map.get("wf_1")).toEqual(["Served", "Skipped", "Degraded"]);
    expect(map.get("wf_ok")).toEqual(["Served"]);
    expect(stretchSentence(map.get("wf_1")!)).toMatch(/dropped the rewrite/i);
  });
});
