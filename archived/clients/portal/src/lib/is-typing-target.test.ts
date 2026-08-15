import { describe, expect, it } from "vitest";
import { isTypingTarget } from "@/lib/is-typing-target";

describe("isTypingTarget (R038)", () => {
  it("treats input/textarea/select as typing", () => {
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    const sel = document.createElement("select");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(sel)).toBe(true);
  });

  it("treats role=textbox as typing (invite-like fields)", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "textbox");
    expect(isTypingTarget(el)).toBe(true);
  });

  it("does not treat a plain button as typing", () => {
    const btn = document.createElement("button");
    expect(isTypingTarget(btn)).toBe(false);
  });
});
