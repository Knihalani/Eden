/**
 * Waves 13–17 core observability — structural + contract tests.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseQueryLanguage,
  serializeQueryLanguage,
  suggestQueryCompletions,
  parsedToSpanSearchParams,
  QUERY_LANGUAGE_FIELDS,
} from "@/lib/query-language";
import { groupParallelTools } from "@/components/transcript-v2/hooks/useParallelGroups";
import type { TranscriptRow } from "@/lib/observability/types";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W13 traces hub / TranscriptV2", () => {
  it("ships TranscriptV2 orchestrator with swimlanes + keyboard + RRWeb thumb", () => {
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/TranscriptV2.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/ParallelToolLane.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/transcript-v2/RrwebThumb.tsx"))).toBe(true);
    const v2 = src("components/transcript-v2/TranscriptV2.tsx");
    expect(v2).toContain("useParallelGroups");
    expect(v2).toContain("useTranscriptKeyboard");
    expect(v2).toContain("RrwebThumb");
  });

  it("VirtualizedTranscript aliases TranscriptV2", () => {
    const virt = src("components/transcript-v2/VirtualizedTranscript.tsx");
    expect(virt).toContain("TranscriptV2");
  });

  it("sunsets transcript-view twin to MessageCards re-export", () => {
    const twin = src("components/observability/transcript-view.tsx");
    expect(twin).toContain("transcript-v2/MessageCards");
    expect(twin).not.toMatch(/ROLE_META/);
  });

  it("TraceDetailPanel uses overflow actions + progressive modes + VirtualizedTranscript", () => {
    const panel = src("components/traces/TraceDetailPanel.tsx");
    expect(panel).toContain('data-testid="trace-actions-overflow"');
    expect(panel).toContain("VirtualizedTranscript");
    expect(panel).toContain('"transcript"');
    expect(panel).toContain("Related issues");
  });

  it("groups overlapping tool rows into parallel_tools blocks", () => {
    const rows: TranscriptRow[] = [
      {
        span_id: "a",
        name: "tool_a",
        timestamp: "2026-01-01T00:00:00Z",
        duration_ms: 100,
        event_type: "tool",
        tool_calls: [{ type: "function", name: "bash" }],
      },
      {
        span_id: "b",
        name: "tool_b",
        timestamp: "2026-01-01T00:00:00Z",
        duration_ms: 80,
        event_type: "tool",
        tool_calls: [{ type: "function", name: "read" }],
      },
      {
        span_id: "c",
        name: "llm",
        timestamp: "2026-01-01T00:00:01Z",
        duration_ms: 200,
        event_type: "llm",
      },
    ];
    const blocks = groupParallelTools(rows);
    expect(blocks.some((b) => b.type === "parallel_tools")).toBe(true);
    const parallel = blocks.find((b) => b.type === "parallel_tools");
    if (parallel?.type === "parallel_tools") {
      expect(parallel.lanes.length).toBe(2);
    }
  });
});

describe("W14 spans / query language", () => {
  it("documents query fields for autocomplete", () => {
    expect(QUERY_LANGUAGE_FIELDS.length).toBeGreaterThanOrEqual(6);
    expect(suggestQueryCompletions("ag").some((s) => s.label === "agent")).toBe(true);
  });

  it("round-trips parse ↔ serialize and maps to span search params", () => {
    const q = serializeQueryLanguage({
      agent_id: "bot",
      outcome: "failure",
      text: "timeout",
    });
    const parsed = parseQueryLanguage(q);
    expect(parsed.agent_id).toBe("bot");
    expect(parsed.outcome).toBe("failure");
    const params = parsedToSpanSearchParams(parsed);
    expect(params.agent).toBe("bot");
    expect(params.outcome).toBe("failure");
    expect(params.q).toContain("timeout");
  });

  it("SpansTab paginates and wires query language + hideable columns", () => {
    const tab = src("components/traces/SpansTab.tsx");
    expect(tab).toContain("parsedToSpanSearchParams");
    expect(tab).toContain("onLoadMore");
    expect(tab).toContain("SPANS_OPTIONAL_COLUMNS");
    expect(tab).toContain('data-testid="spans-columns-menu"');
    expect(tab).toContain("setPage");
  });

  it("QueryFilterBar exposes autocomplete + Advanced drawer + create-alert", () => {
    const bar = src("components/portal-os/QueryFilterBar.tsx");
    expect(bar).toContain("suggestQueryCompletions");
    expect(bar).toContain("Unknown field");
    expect(bar).toContain("setQueryDraft(query)");
    expect(bar).toContain("clearedFilters");
    expect(bar).toContain("Create alert from filters");
    expect(bar).toContain('data-testid="query-filter-advanced-panel"');
    // Save-as-signal lives on SpanSearchBar, not a dead QueryFilterBar affordance.
    expect(bar).not.toContain("onSaveAsSignal");
    expect(bar).not.toContain("Save as signal");
  });

  it("SpanSearchBar saves signal with cost preview", () => {
    const bar = src("app/(portal)/traces/_components/SpanSearchBar.tsx");
    expect(bar).toContain("previewSearchAsSignal");
    expect(bar).toContain("saveSearchAsSignal");
    expect(bar).toContain("Save as signal");
  });
});

describe("W15 sessions + RRWeb", () => {
  it("BrowserReplayPanel uses rrweb-player not JSON iframe", () => {
    const panel = src("components/browser/BrowserReplayPanel.tsx");
    // K10: parent must not pull rrweb into the first-load graph — UMD
    // loads only inside the sandboxed iframe via /api/rrweb-player.
    expect(panel).not.toMatch(/import\(["']rrweb-player["']\)/);
    expect(panel).not.toMatch(/import RrwebPlayer from ["']rrweb-player["']/);
    expect(panel).toContain("/api/rrweb-player/");
    // F09: replay must run in sandboxed srcDoc iframe (no parent origin access).
    expect(panel).toContain("srcDoc");
    expect(panel).toContain("sandbox=");
    expect(panel).toContain('sandbox="allow-scripts"');
    expect(panel).not.toMatch(/sandbox="[^"]*allow-same-origin/);
    expect(panel).not.toMatch(/sandbox=\{[^}]*allow-same-origin/);
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies["rrweb-player"]).toBeTruthy();
  });

  it("SessionHeader surfaces D12 contract", () => {
    expect(src("components/sessions/SessionHeader.tsx")).toContain("eden-agent-session-v1");
  });

  it("session page wires turn scrub to replay activeStep", () => {
    const page = src("app/(portal)/sessions/[sessionId]/page.tsx");
    expect(page).toContain("activeStep");
    expect(page).toContain("SessionTurnTimeline");
    expect(page).toContain("BrowserReplayPanel");
  });
});

describe("W16 issues triage (no F22 investment)", () => {
  it("wires bulk triage/resolve via agentIssuesApi", () => {
    const page = src("app/(portal)/issues/page.tsx");
    expect(page).toContain("agentIssuesApi.triage");
    expect(page).toContain("agentIssuesApi.resolve");
  });

  it("issue detail uses handoff CTAs instead of Fix tab investment", () => {
    const detail = src("app/(portal)/issues/[id]/page.tsx");
    const handoff = src("app/(portal)/issues/_components/issue-handoff.tsx");
    expect(detail).toContain("IssueHandoffPanel");
    expect(handoff).toContain("handoff");
    expect(handoff).toContain("View improvement plan");
    expect(handoff).toContain("Open in coding agent");
    expect(handoff).toContain("Export fixture");
    expect(detail).not.toMatch(/id: "fix"/);
  });
});

describe("W17 alerts + signals", () => {
  it("alerts empty state offers Create-rule CTA", () => {
    const page = src("app/(portal)/alerts/page.tsx");
    const feed = src("app/(portal)/alerts/_components/alerts-feed.tsx");
    const sheet = src("app/(portal)/alerts/_components/alert-rules-sheet.tsx");
    expect(feed).toContain("alerts-create-rule-cta");
    expect(feed).toContain("Create rule");
    expect(page).toContain("real_incident");
    expect(feed).toContain("benign");
    expect(sheet).toContain("compileNlAlert");
  });

  it("signals library remains reachable from alerts tab", () => {
    const alerts = src("app/(portal)/alerts/page.tsx");
    const hook = src("app/(portal)/alerts/_components/use-alerts-page.ts");
    const feed = src("app/(portal)/alerts/_components/alerts-feed.tsx");
    expect(hook).toContain('useQueryTab("tab", ALERT_TABS, "feed")');
    expect(feed).toContain('value="signals"');
    expect(alerts).toContain("@/components/ui/tabs");
    expect(existsSync(resolve(ROOT, "src/app/(portal)/signals/page.tsx"))).toBe(true);
  });
});
