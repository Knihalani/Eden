/**
 * W3-5 — Debugger sessions false empty / in-page errors.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function showSessionsEmpty(opts: {
  loading: boolean;
  error: string | null;
  count: number;
}): boolean {
  return !opts.loading && !opts.error && opts.count === 0;
}

describe("W3-5 debugger-sessions query states", () => {
  it("list page uses ErrorState before EmptyState", () => {
    const src = read("app/(portal)/debugger-sessions/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load sessions");
    expect(src).toContain("Try again");
    expect(src).toMatch(/error \? \([\s\S]*ErrorState[\s\S]*\) : loading \?/);
  });

  it("does not show empty while loading or on error", () => {
    expect(
      showSessionsEmpty({ loading: true, error: null, count: 0 }),
    ).toBe(false);
    expect(
      showSessionsEmpty({ loading: false, error: "boom", count: 0 }),
    ).toBe(false);
    expect(
      showSessionsEmpty({ loading: false, error: null, count: 0 }),
    ).toBe(true);
  });

  it("detail page uses ErrorState and handles not_found without false empty", () => {
    const src = read("app/(portal)/debugger-sessions/[id]/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load session");
    expect(src).toContain('status === "not_found"');
    expect(src).toMatch(/loading \?[\s\S]*: error \?[\s\S]*: !session \?/);
  });
});
