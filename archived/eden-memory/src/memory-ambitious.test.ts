/**
 * Math and chatter cues stay no-op cues. The EDEN_MEMORY_X A/B that also lived here went with the flag.
 */
import { describe, expect, test } from "bun:test";
import { isNoopCue as isMathChatterCue } from "./memory-sota";

describe("math and chatter cues", () => {
  test("isMathChatterCue", () => {
    expect(isMathChatterCue("what's 2+2?")).toBe(true);
    expect(isMathChatterCue("What is 17 times 23?")).toBe(true);
    expect(isMathChatterCue("thanks")).toBe(true);
    expect(isMathChatterCue("why is login broken?")).toBe(false);
    expect(isMathChatterCue("what database do we use")).toBe(false);
  });
});
