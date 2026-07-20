/**
 * Wave 20 — ChatSidebar spine structural tests.
 * open → send → tool_card / approval / charts / dual-surface gone.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiModules } from "./_read-api";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const apiSrc = () => readApiModules(ROOT);
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");

describe("W20 ChatSidebar split + chrome", () => {
  it("splits into hooks + SessionList + MessageList + Composer", () => {
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/hooks/useChatSidebar.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/SessionList.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/MessageList.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/Composer.tsx"))).toBe(true);
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("useChatSidebar");
    expect(shell).toContain("SessionList");
    expect(shell).toContain("MessageList");
    expect(shell).toContain("Composer");
    expect(shell.split("\n").length).toBeLessThan(250);
  });

  it("gates on features.f70, Sheet on mobile, Esc + focus trap", () => {
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("Sheet");
    expect(shell).toContain("f70Enabled");
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("feature-flags");
    expect(hook).toContain("f70");
    expect(hook).toContain("Escape");
    expect(hook).toContain("stopStreaming");
    expect(hook).toContain("focusables");
  });
});

describe("W20 rehydrate + charts + citations", () => {
  it("forwards chart and citation SSE in insights_compat", () => {
    const compat = py("eden/autonomous/insights_compat.py");
    expect(compat).toContain('"type": "chart"');
    expect(compat).toContain('"type": "citation"');
    expect(compat).toContain("chart_specs");
    expect(compat).toContain("citations");
  });

  it("reuses conversation UUID in ChatService", () => {
    const agent = py("eden/autonomous/agent.py");
    expect(agent).toContain("ON CONFLICT (id) DO NOTHING");
    expect(agent).toContain("INSERT INTO ai_conversations (id, org_id, user_id, title");
  });

  it("sessions/list/archive use ai_conversations", () => {
    const routes = py("eden/api/routes/ai_insights.py");
    expect(routes).toContain("FROM ai_conversations");
    expect(routes).toContain("UPDATE ai_conversations SET archived_at");
    expect(routes).not.toContain("FROM ai_insights_chat_sessions");
  });

  it("MessageList renders AiChartRenderer and cite→trace links", () => {
    const list = src("components/ai-insights/MessageList.tsx");
    expect(list).toContain("AiChartRenderer");
    expect(list).toContain("/traces?trace_id=");
    expect(list).toContain("CitationChip");
  });

  it("hook handles chart + citation SSE and rehydrates tool_use", () => {
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain('case "chart"');
    expect(hook).toContain('case "citation"');
    expect(hook).toContain("tool_use");
    expect(hook).toContain("/api/ai-insights/chat");
  });
});

describe("W20 approvals + dual surface gone", () => {
  it("write tools are approval-gated with RBAC", () => {
    const agent = py("eden/autonomous/agent.py");
    expect(agent).toContain("_APPROVAL_GATED_TOOLS");
    expect(agent).toContain("approval_required");
    expect(agent).toContain("execute_approved");
    expect(agent).toContain("create_alert_rule");
  });

  it("ApprovalCard only for writes; approve proxy exists", () => {
    const card = src("components/ai-insights/ApprovalCard.tsx");
    expect(card).toContain("data-approval-card");
    expect(card).toContain("/api/ai-insights/approve");
    expect(existsSync(resolve(ROOT, "src/app/api/ai-insights/approve/route.ts"))).toBe(true);
    const types = src("components/ai-insights/types.ts");
    expect(types).toContain("needsApproval");
    const routes = py("eden/api/routes/ai_insights.py");
    expect(routes).toContain('action=f"ai_insights.tool.approve.');
  });

  it("ToolCallCard redacts PII", () => {
    const card = src("components/ai-insights/ToolCallCard.tsx");
    expect(card).toContain("redactPii");
  });

  it("deletes Phase-C aiApi and unmounts /ai router", () => {
    const api = apiSrc();
    expect(api).not.toContain("export const aiApi");
    expect(api).not.toContain("/orgs/${orgId}/ai/chat");
    expect(api).toContain("export interface AiChartSpec");
    const app = py("eden/api/app.py");
    expect(app).not.toMatch(/include_router\(ai_agent\.router\)/);
  });
});

describe("W20 open→send→tool_card structural path", () => {
  it("wires open toggle, submit, and tool card rendering", () => {
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("Open AI assistant");
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("eden:toggle-ai-chat");
    expect(hook).toContain("tool_call");
    expect(hook).toContain("tool_result");
    const list = src("components/ai-insights/MessageList.tsx");
    expect(list).toContain("ToolCallCard");
    expect(list).toContain("ApprovalCard");
    expect(list).toContain("needsApproval");
    const composer = src("components/ai-insights/Composer.tsx");
    expect(composer).toContain("Stop generating");
    expect(composer).toContain("onSubmit");
  });
});
