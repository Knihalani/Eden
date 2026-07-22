/**
 * Wave 4 (Observe V3) — Sessions turn cards + session page mode URL.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSessionTurns,
  turnInputPreview,
  turnOutputPreview,
  truncateTurnPreview,
} from "@/components/sessions/session-turn-preview";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W4 sessions cards — turn preview helpers", () => {
  it("truncates long previews", () => {
    expect(truncateTurnPreview("short")).toBe("short");
    expect(truncateTurnPreview("x".repeat(130))).toMatch(/…$/);
    expect(truncateTurnPreview("   ")).toBeNull();
  });

  it("prefers input_text / output_text with fallbacks", () => {
    expect(
      turnInputPreview({
        trace_id: "t1",
        input_text: "hello user",
        name: "ignored",
      }),
    ).toBe("hello user");
    expect(
      turnInputPreview({
        trace_id: "t1",
        realm: "production",
      }),
    ).toBe("production run");
    expect(
      turnOutputPreview({
        trace_id: "t1",
        output_text: "model reply",
        error: "ignored",
      }),
    ).toBe("model reply");
    expect(
      turnOutputPreview({
        trace_id: "t1",
        error: "boom",
      }),
    ).toBe("boom");
  });

  it("buildSessionTurns preserves order and marks stumbles", () => {
    const turns = buildSessionTurns(
      ["a", "b"],
      [
        {
          trace_id: "b",
          outcome: "failure",
          input_text: "q2",
          output_text: "a2",
          duration_ms: 20,
        },
        {
          trace_id: "a",
          outcome: "success",
          input_text: "q1",
          output_text: "a1",
          duration_ms: 10,
        },
      ],
    );
    expect(turns.map((t) => t.trace_id)).toEqual(["a", "b"]);
    expect(turns[0]!.input_preview).toBe("q1");
    expect(turns[0]!.output_preview).toBe("a1");
    expect(turns[1]!.had_stumble).toBe(true);
    expect(turns[0]!.had_stumble).toBe(false);
  });
});

describe("W4 sessions cards — hub expand + session page modes", () => {
  it("SessionsTab expands to numbered TurnCards with Input/Output", () => {
    const sessions = read("components/traces/SessionsTab.tsx");
    expect(sessions).toContain('data-testid="session-expand-panel"');
    expect(sessions).toContain("SessionTurnTimeline");
    expect(sessions).toContain('layout="stack"');
    expect(sessions).toContain("onSelectTrace");
    expect(sessions).toContain("selectedTraceId");
    expect(sessions).toContain("buildSessionTurns");
    expect(sessions).toContain('openTraceView="sessions"');
    // Still under hub sessions lens — no new Observe nav leaf
    expect(sessions).not.toMatch(/href=\{?["']\/observe/);
  });

  it("TurnCard shows 1/N + Input + Output previews", () => {
    const card = read("components/sessions/TurnCard.tsx");
    expect(card).toContain("Turn {index + 1}/{total}");
    expect(card).toContain('data-testid="turn-input-preview"');
    expect(card).toContain('data-testid="turn-output-preview"');
    expect(card).toContain("inputPreview");
    expect(card).toContain("outputPreview");
  });

  it("session page wires transcript-first mode URL like hub", () => {
    const page = read("app/(portal)/sessions/[sessionId]/page.tsx");
    expect(page).toContain("SESSION_DETAIL_MODES");
    expect(page).toContain('"transcript"');
    expect(page).toContain("initialMode={detailMode}");
    expect(page).toContain("onModeChange={handleDetailModeChange}");
    expect(page).toContain('mode === "transcript"');
    expect(page).toContain('next.delete("mode")');
    expect(page).toContain("SessionTurnTimeline");
    expect(page).toContain('q.set("view", "sessions")');
    expect(page).toContain("preserveFromSearchParams");
    expect(page).toContain("buildSessionTurns");
    expect(page).toContain('readMasterDetailParam(searchParams, "spanId")');
    expect(page).toContain("highlightSpanId={selectedSpanId}");
    expect(page).toContain("onSpanSelect={handleSelectSpan}");
  });

  it("hub list passes selectedTraceId into SessionsTab", () => {
    const list = read("app/(portal)/traces/_components/traces-hub-list.tsx");
    expect(list).toContain("selectedTraceId={traceId || undefined}");
    expect(list).toContain("onSelectTrace={handleSelectTrace}");
    expect(list).toContain("preserve={{");
  });

  it("TurnCard Open-trace uses traceHref with preserve", () => {
    const card = read("components/sessions/TurnCard.tsx");
    expect(card).toContain("traceHref");
    expect(card).toContain("preserve");
  });

  it("hub Open-session and detail Open-session preserve filters via sessionHref", () => {
    const tab = read("components/traces/SessionsTab.tsx");
    const topbar = read("components/trace-viewer/UnifiedTopBar.tsx");
    const cross = read("lib/portal-cross-links.ts");
    expect(cross).toContain("export function sessionHref");
    expect(tab).toContain("sessionHref(expanded.id, preserve)");
    expect(topbar).toContain("sessionHref(sessionId, linkPreserve)");
  });

  it("session timeline arrow keys are scoped to timeline root", () => {
    const timeline = read("components/sessions/SessionTurnTimeline.tsx");
    expect(timeline).toContain("rootRef.current?.contains(target)");
    expect(timeline).toContain('data-testid="session-turn-timeline"');
  });
});
