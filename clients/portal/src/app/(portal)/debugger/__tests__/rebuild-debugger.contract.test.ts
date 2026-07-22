/**
 * Phase 6 Debugger contract — surfaces/debugger.md acceptance.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = path.resolve(__dirname, "../../../..");
const debuggerRoot = path.join(portalSrc, "app/(portal)/debugger");
const libRoot = path.join(portalSrc, "lib");
const messagesEn = path.join(portalSrc, "messages/en.json");
const messagesDe = path.join(portalSrc, "messages/de.json");
const sidebarConfig = path.join(libRoot, "sidebar-config.ts");
const nextConfig = path.resolve(portalSrc, "../../next.config.ts");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("rebuild Debugger contract", () => {
  it("/debugger page and loading exist", () => {
    expect(existsSync(path.join(debuggerRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(debuggerRoot, "loading.tsx"))).toBe(true);
  });

  it("/debugger/[id] page and loading exist", () => {
    expect(existsSync(path.join(debuggerRoot, "[id]/page.tsx"))).toBe(true);
    expect(existsSync(path.join(debuggerRoot, "[id]/loading.tsx"))).toBe(true);
  });

  it("debugger-url lib exists with canonical params", () => {
    const url = read(path.join(libRoot, "debugger-url.ts"));
    expect(url).toContain("leftTraceId");
    expect(url).toContain("rightTraceId");
    expect(url).toContain("DEBUGGER_TABS");
    expect(url).toContain("DEBUGGER_MODES");
    expect(url).toContain('"replay"');
    expect(url).toContain('"compare"');
    expect(url).toContain('"time-travel"');
    expect(url).toContain('"notes"');
  });

  it("debugger is NOT in CORE_NAV_LEAF_IDS", () => {
    const config = read(sidebarConfig);
    const idsMatch = config.match(/CORE_NAV_LEAF_IDS = \[([\s\S]*?)\] as const/);
    expect(idsMatch?.[1]).not.toContain('"debugger"');
  });

  it("Debugger appears in MOBILE_MORE_NAV with /debugger href", () => {
    const config = read(sidebarConfig);
    expect(config).toContain('"debugger"');
    expect(config).toContain('href: "/debugger"');
  });

  it("CommandPalette includes Debugger entry", () => {
    const palette = read(path.join(portalSrc, "components/ui/command-palette.tsx"));
    expect(palette).toContain('"/debugger"');
    expect(palette).toContain("debugger");
  });

  it("detail page has all four modes", () => {
    const detail = read(path.join(debuggerRoot, "[id]/page.tsx"));
    expect(detail).toContain('"replay"');
    expect(detail).toContain('"compare"');
    expect(detail).toContain('"time-travel"');
    expect(detail).toContain('"notes"');
  });

  it("detail page uses debugSessionsApi and debuggerApi", () => {
    const detail = read(path.join(debuggerRoot, "[id]/page.tsx"));
    expect(detail).toContain("debugSessionsApi");
    expect(detail).toContain("debuggerApi");
  });

  it("list page seeds from traceId param", () => {
    const list = read(path.join(debuggerRoot, "page.tsx"));
    expect(list).toContain("traceId");
    expect(list).toContain("source_trace_id");
  });

  it("redirects from /replay and /debugger-sessions in next.config.ts", () => {
    if (!existsSync(nextConfig)) return;
    const config = read(nextConfig);
    expect(config).toContain('"/debugger-sessions"');
    expect(config).toContain('"/debugger"');
    expect(config).toContain('"/replay"');
    expect(config).toContain('"tab=replay"');
  });

  it("no softLand for /debugger in next.config.ts", () => {
    if (!existsSync(nextConfig)) return;
    const config = read(nextConfig);
    const softLandBlock = config.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBlock).not.toContain('"/debugger"');
  });

  it("Traces detail panel uses /debugger (not /_stub/debugger)", () => {
    const detail = read(
      path.join(portalSrc, "app/(portal)/traces/_components/detail-panel.tsx"),
    );
    expect(detail).toContain('`/debugger?traceId=');
    expect(detail).not.toContain("/_stub/debugger");
  });

  it("i18n debugger namespace in en and de", () => {
    const en = JSON.parse(read(messagesEn)) as Record<string, unknown>;
    const de = JSON.parse(read(messagesDe)) as Record<string, unknown>;
    expect(en.debugger).toBeTruthy();
    expect(de.debugger).toBeTruthy();
  });

  it("copy distinguishes DebuggerSession from Sessions (Observe)", () => {
    const en = JSON.parse(read(messagesEn)) as Record<string, unknown>;
    const dbg = en.debugger as Record<string, unknown>;
    // debugger title is 'Debugger' not 'Sessions'
    expect(dbg.title).toBeTruthy();
    expect(dbg.title).not.toBe("Sessions");
  });

  it("no /redteam usage in debugger pages", () => {
    const list = read(path.join(debuggerRoot, "page.tsx"));
    const detail = read(path.join(debuggerRoot, "[id]/page.tsx"));
    expect(list).not.toContain("redteam");
    expect(detail).not.toContain("redteam");
  });
});
