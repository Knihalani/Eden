import { describe, expect, it } from "vitest";
import { shouldCreateThreadOnVisit } from "@/lib/assistant-boot";

describe("assistant boot (R028)", () => {
  it("does not auto-create an empty New chat on a bare visit", () => {
    expect(
      shouldCreateThreadOnVisit({
        hasHandoffPins: false,
        hasPrompt: false,
        threadParam: null,
      }),
    ).toBe(false);
  });

  it("creates only for an explicit handoff or New chat", () => {
    expect(
      shouldCreateThreadOnVisit({
        hasHandoffPins: true,
        hasPrompt: false,
        threadParam: null,
      }),
    ).toBe(true);
    expect(
      shouldCreateThreadOnVisit({
        hasHandoffPins: false,
        hasPrompt: true,
        threadParam: null,
      }),
    ).toBe(true);
  });
});
