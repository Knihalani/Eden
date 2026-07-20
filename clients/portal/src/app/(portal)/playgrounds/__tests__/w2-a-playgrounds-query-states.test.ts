/**
 * W2-A — Playgrounds false empty / in-page errors.
 *
 * Source-level regression: empty must wait for listQuery settlement;
 * ErrorState + retry must be in-page (not toast-only).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of playgrounds list UI gate (keep in sync with page.tsx). */
function showPlaygroundsEmpty(opts: {
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  playgroundCount: number;
}): boolean {
  const loading =
    (opts.isLoading || opts.isPending) && opts.playgroundCount === 0;
  const listError = opts.isError;
  return !loading && !listError && opts.playgroundCount === 0;
}

describe("W2-A playgrounds query states", () => {
  it("gates empty on isLoading / isPending / isError via QueryState", () => {
    const src = read("app/(portal)/playgrounds/page.tsx");
    expect(src).not.toMatch(/!playgrounds\.length && !busy/);
    expect(src).toMatch(/listQuery\.isLoading/);
    expect(src).toMatch(/listQuery\.isPending/);
    expect(src).toMatch(/listQuery\.isError/);
    expect(src).toContain("<QueryState");
    expect(src).toContain("isEmpty={(rows) => rows.length === 0}");
  });

  it("renders in-page QueryState with retry", () => {
    const src = read("app/(portal)/playgrounds/page.tsx");
    expect(src).toContain('from "@/components/ui/query-state"');
    expect(src).toContain("Could not load playgrounds");
    expect(src).toContain("<QueryState");
    expect(src).toContain("onRetry={() => void load()}");
  });

  it("does not show empty while loading or on error", () => {
    expect(
      showPlaygroundsEmpty({
        isLoading: true,
        isPending: false,
        isError: false,
        playgroundCount: 0,
      }),
    ).toBe(false);
    expect(
      showPlaygroundsEmpty({
        isLoading: false,
        isPending: true,
        isError: false,
        playgroundCount: 0,
      }),
    ).toBe(false);
    expect(
      showPlaygroundsEmpty({
        isLoading: false,
        isPending: false,
        isError: true,
        playgroundCount: 0,
      }),
    ).toBe(false);
    expect(
      showPlaygroundsEmpty({
        isLoading: false,
        isPending: false,
        isError: false,
        playgroundCount: 0,
      }),
    ).toBe(true);
  });

  it("soft-fails datasets so playgrounds list stays authoritative", () => {
    const src = read("app/(portal)/playgrounds/page.tsx");
    expect(src).toMatch(/datasets are soft-fail|soft-fail/);
    expect(src).toMatch(/try \{\s*const ds = await datasetsApi\.list/s);
    expect(src).not.toMatch(/Promise\.all\(\[\s*fetchApi[\s\S]*datasetsApi\.list/s);
  });
});
