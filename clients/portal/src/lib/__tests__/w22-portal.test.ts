/**
 * Wave 22 — ChatSidebar alerts, signals, downloads (structural + unit).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeClientToolAction,
  extractClientAction,
} from "@/components/ai-insights/clientToolExecutors";
import { expandSlashInput, SLASH_COMMANDS } from "@/components/ai-insights/slashCommands";
import { needsApproval, type ToolCall } from "@/components/ai-insights/types";
import { toCsv, toXlsxBlob } from "@/lib/export";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");

describe("W22 alert + signal approval path", () => {
  it("registers preview/create alert+signal and promote_artifact", () => {
    const tools = py("eden/llmops/insights_tools.py");
    for (const name of [
      "preview_nl_alert",
      "create_alert_rule",
      "preview_nl_signal",
      "create_signal",
      "promote_artifact",
      "export_table",
      "list_analysis_templates",
      "run_analysis_template",
      "query_sql",
    ]) {
      expect(tools).toContain(`name="${name}"`);
    }
    expect(tools).toContain('"client_action": "download"');
    expect(tools).toContain("spend_preview");
    expect(tools).toContain("_ANALYSIS_TEMPLATES");
  });

  it("gates writes + spend confirms in agent approve path", () => {
    const agent = py("eden/autonomous/agent.py");
    expect(agent).toContain('"create_signal"');
    expect(agent).toContain('"promote_artifact"');
    expect(agent).toContain("_SPEND_CONFIRM_TOOLS");
    expect(agent).toContain('"export_table"');
    expect(agent).toContain("confirm_spend");
    expect(agent).toContain("forbidden SQL keyword");

    const routes = py("eden/api/routes/ai_insights.py");
    expect(routes).toContain("_SPEND_CONFIRM_TOOLS");
    expect(routes).toContain("_APPROVAL_GATED_TOOLS | _SPEND_CONFIRM_TOOLS");
  });

  it("ApprovalCard wires alert + signal + spend preview", () => {
    const card = src("components/ai-insights/ApprovalCard.tsx");
    expect(card).toContain("preview_nl_signal");
    expect(card).toContain("signalsApi.create");
    expect(card).toContain("nlAlertsApi.createRule");
    expect(card).toContain("spendPreview");
    expect(card).toContain("executeClientToolAction");

    const types = src("components/ai-insights/types.ts");
    expect(types).toContain("preview_nl_signal");

    const alertTc: ToolCall = {
      id: "1",
      name: "preview_nl_alert",
      input: {},
    };
    expect(needsApproval(alertTc)).toBe(true);

    const signalTc: ToolCall = {
      id: "2",
      name: "preview_nl_signal",
      input: {},
      result: {
        status: "ok",
        output: {
          approval_required: true,
          description: "refusal rate > 5%",
          rule: { metric: "refusal_rate", op: ">", threshold: 0.05 },
        },
      },
    };
    expect(needsApproval(signalTc)).toBe(true);
  });
});

describe("W22 export CSV of slow traces", () => {
  it("export_table download client_action triggers CSV", () => {
    const clicks: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        vi.spyOn(el, "click").mockImplementation(() => {
          clicks.push((el as HTMLAnchorElement).download || "");
        });
      }
      return el;
    });

    const action = extractClientAction({
      client_action: "download",
      format: "csv",
      filename: "slow_traces.csv",
      rows: [
        { trace_id: "trc_1", duration_ms: 5000 },
        { trace_id: "trc_2", duration_ms: 3000 },
      ],
    });
    expect(action).toMatchObject({
      client_action: "download",
      format: "csv",
      filename: "slow_traces.csv",
    });

    expect(
      executeClientToolAction(
        {
          client_action: "download",
          format: "csv",
          filename: "slow_traces.csv",
          rows: [{ trace_id: "trc_slow", duration_ms: 9000 }],
        },
        { navigate: () => undefined },
      ),
    ).toBe(true);
    expect(clicks.some((c) => c.includes("slow_traces"))).toBe(true);
  });

  it("toCsv + toXlsxBlob produce non-empty exports", () => {
    const rows = [
      { trace_id: "a", duration_ms: 100 },
      { trace_id: "b", duration_ms: 200 },
    ];
    const csv = toCsv(rows);
    expect(csv).toContain("trace_id");
    expect(csv).toContain("a");
    const blob = toXlsxBlob(rows);
    expect(blob.size).toBeGreaterThan(100);
    expect(blob.type).toContain("spreadsheetml");
  });

  it("slash /export|/sql|/signal expand to real tools", () => {
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toContain("/signal");
    expect(expandSlashInput("/export slow traces")).toContain("export_table");
    expect(expandSlashInput("/sql")).toContain("query_sql");
    expect(expandSlashInput("/signal refusal")).toContain("preview_nl_signal");
    expect(expandSlashInput("/alert cost")).toContain("preview_nl_alert");
  });

  it("chart PNG/CSV + multi-chart bundle surface", () => {
    const chart = src("components/ai/ai-chart-renderer.tsx");
    expect(chart).toContain("downloadCsv");
    expect(chart).toContain("downloadPng");
    const list = src("components/ai-insights/MessageList.tsx");
    expect(list).toContain("downloadChartBundle");
    expect(list).toContain("downloadXlsx");
    expect(existsSync(resolve(ROOT, "src/lib/export.ts"))).toBe(true);
    expect(src("lib/export.ts")).toContain("downloadXlsx");
  });
});
