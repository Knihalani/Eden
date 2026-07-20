/**
 * W3-5 — Debugger false empty / F48 contract (portal ↔ debugger.py).
 *
 * Checkpoint load failures must use in-page ErrorState (not toast + empty table).
 * Client paths/types must match backend: path-scoped checkpoints, no rewind.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of debugger checkpoint UI gate (keep in sync with page.tsx). */
function showCheckpointsEmpty(opts: {
  loading: boolean;
  error: string | null;
  rowCount: number;
  hasTraceId: boolean;
}): boolean {
  if (opts.error) return false;
  if (opts.loading) return false;
  return opts.rowCount === 0;
}

describe("W3-5 debugger query states", () => {
  it("uses ErrorState with retry (not toast-only empty table)", () => {
    const src = read("app/(portal)/debugger/page.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load checkpoints");
    expect(src).toContain("Try again");
    expect(src).toMatch(/setError\(msg\)/);
    expect(src).not.toMatch(/toast\.error\(msg\);\s*setCheckpoints\(\[\]\)/);
  });

  it("gates empty table behind error", () => {
    expect(
      showCheckpointsEmpty({
        loading: false,
        error: "boom",
        rowCount: 0,
        hasTraceId: true,
      }),
    ).toBe(false);
    expect(
      showCheckpointsEmpty({
        loading: true,
        error: null,
        rowCount: 0,
        hasTraceId: true,
      }),
    ).toBe(false);
    expect(
      showCheckpointsEmpty({
        loading: false,
        error: null,
        rowCount: 0,
        hasTraceId: true,
      }),
    ).toBe(true);
  });

  it("passes session_id on rerun (F74 / debugger.py RerunRequest)", () => {
    const src = read("app/(portal)/debugger/page.tsx");
    expect(src).toMatch(/session_id:\s*sessionId\.trim\(\)/);
    expect(src).toContain('searchParams.get("session_id")');
  });
});

describe("W3-5 F48 debuggerApi contract", () => {
  it("listCheckpoints uses path-scoped trace_id; no rewind", () => {
    const src = read("lib/api/resources.ts");
    const block = src.split("const debuggerApi")[1]?.split("const debugSessionsApi")[0] ?? "";
    expect(block).toContain("/debugger/checkpoints/${encodeURIComponent(traceId)}");
    expect(block).not.toContain("rewind");
    expect(block).toContain("listCheckpoints");
    expect(block).toContain("rerun:");
    expect(block).toMatch(/session_id\?:/);
    expect(src).toContain("step_number");
    expect(src).toContain("prompt_override");
    expect(src).not.toMatch(/debugger\/rewind/);
  });

  it("debugSessionsApi paths match debugger.py /sessions routes", () => {
    const src = read("lib/api/resources.ts");
    const block = src.split("const debugSessionsApi")[1]?.split("const browserSessionsApi")[0] ?? "";
    expect(block).toContain("/debugger/sessions?limit=");
    expect(block).toContain("/debugger/sessions/${sessionId}");
    expect(block).toContain("/compare?run_a=");
  });
});
