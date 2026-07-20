/**
 * Wave 23 — ChatSidebar SOTA (Loop-class): datasets/experiments/playgrounds,
 * T2-only routing (no model picker), cite-before-claim, rate limits, TTFT, golden paths.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeClientToolAction,
  extractClientAction,
} from "@/components/ai-insights/clientToolExecutors";
import {
  expandSlashInput,
  SLASH_COMMANDS,
} from "@/components/ai-insights/slashCommands";
import {
  CHAT_PREFERRED_TIER,
  needsApproval,
  type ToolCall,
} from "@/components/ai-insights/types";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");

describe("W23 dataset / experiment / playground tools", () => {
  it("registers evaluate tools + estimate_chat_cost", () => {
    const tools = py("eden/llmops/insights_tools.py");
    for (const name of [
      "list_datasets",
      "create_dataset",
      "promote_trace_to_dataset",
      "list_experiments",
      "summarize_experiment",
      "create_experiment",
      "list_playgrounds",
      "create_playground",
      "playground_from_span",
      "estimate_chat_cost",
    ]) {
      expect(tools).toContain(`name="${name}"`);
    }
  });

  it("gates evaluate writes in agent approve path", () => {
    const agent = py("eden/autonomous/agent.py");
    for (const name of [
      "create_dataset",
      "promote_trace_to_dataset",
      "create_experiment",
      "create_playground",
      "playground_from_span",
    ]) {
      expect(agent).toContain(`"${name}"`);
    }
    expect(agent).toContain("_APPROVAL_GATED_TOOLS");
    expect(agent).toContain("_WRITE_INSIGHTS_TOOLS");
  });

  it("needsApproval covers evaluate mutations", () => {
    for (const name of [
      "create_dataset",
      "promote_trace_to_dataset",
      "create_experiment",
      "create_playground",
      "playground_from_span",
    ]) {
      const tc: ToolCall = { id: "1", name, input: {} };
      expect(needsApproval(tc)).toBe(true);
    }
  });
});

describe("W23 T2 routing + cost / TTFT (no model picker)", () => {
  it("ships chat_sota helpers and ChatService wiring", () => {
    expect(existsSync(resolve(ROOT, "../../src/eden/llmops/chat_sota.py"))).toBe(
      true,
    );
    const sota = py("eden/llmops/chat_sota.py");
    expect(sota).toContain("classify_chat_tier");
    expect(sota).toContain("cite_before_claim");
    expect(sota).toContain("ttft_budget_ms");
    expect(sota).toContain("estimate_turn_cost_usd");
    expect(sota).toContain("MODEL_PICKER");
    expect(sota).toContain('return ModelTier.T2');

    const agent = py("eden/autonomous/agent.py");
    expect(agent).toContain("preferred_tier");
    expect(agent).toContain("cite_before_claim");
    expect(agent).toContain("ttft_ms");
    expect(agent).toContain('type="meta"');
    expect(agent).toContain("model_for_tier(ModelTier.T2)");
    expect(agent).not.toContain('slot="reasoning"');
  });

  it("ChatRequest + rate limit on ai_insights chat", () => {
    const routes = py("eden/api/routes/ai_insights.py");
    expect(routes).toContain("preferred_model");
    expect(routes).toContain("preferred_tier");
    expect(routes).toContain("_chat_rate_limiter");
    expect(routes).toContain("RateLimitExceeded");
    expect(routes).toContain("429");
  });

  it("Composer has no model picker; hook always POSTs t2", () => {
    expect(CHAT_PREFERRED_TIER).toBe("t2");

    const composer = src("components/ai-insights/Composer.tsx");
    expect(composer).not.toContain("CHAT_MODEL_OPTIONS");
    expect(composer).not.toContain("aria-label=\"Chat model tier\"");
    expect(composer).toContain("data-session-spend");
    expect(composer).toContain("data-ttft");

    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("CHAT_PREFERRED_TIER");
    expect(hook).toContain("preferred_tier");
    expect(hook).not.toContain("resolvePreferredTier");
    expect(hook).not.toContain("modelOption");
    expect(hook).toContain('case "meta"');

    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("MessageSquare");
    expect(shell).not.toMatch(/\bTerminal\b/);
  });
});

describe("W23 golden chat structural suite", () => {
  it("filter path: propose_filter client_action", () => {
    const action = extractClientAction({
      client_action: "propose_filter",
      q: "latency_ms > 2000",
      href: "/traces?q=latency_ms%20%3E%202000",
    });
    expect(action).toMatchObject({
      client_action: "propose_filter",
      q: "latency_ms > 2000",
    });
    const navigated: string[] = [];
    expect(
      executeClientToolAction(action, {
        navigate: (h) => navigated.push(h),
      }),
    ).toBe(true);
    expect(navigated[0]).toContain("/traces");
    expect(expandSlashInput("/filter slow")).toMatch(/filter/i);
  });

  it("cite path: MessageList CitationChip + cite-before-claim", () => {
    const list = src("components/ai-insights/MessageList.tsx");
    expect(list).toContain("CitationChip");
    expect(list).toContain("citations");
    const agent = py("eden/autonomous/agent.py");
    expect(agent).toContain("Cite-before-claim");
    expect(py("eden/llmops/chat_sota.py")).toContain("cite_before_claim");
  });

  it("alert path: preview_nl_alert approval", () => {
    const tc: ToolCall = {
      id: "a1",
      name: "preview_nl_alert",
      input: {},
      result: {
        status: "ok",
        output: { eql: "cost > 1", nl_text: "cost spike", approval_required: true },
      },
    };
    expect(needsApproval(tc)).toBe(true);
    expect(expandSlashInput("/alert cost")).toContain("preview_nl_alert");
  });

  it("export path: download client_action CSV", () => {
    const action = extractClientAction({
      client_action: "download",
      format: "csv",
      filename: "export.csv",
      rows: [{ id: "1" }],
    });
    expect(action?.client_action).toBe("download");
    expect(expandSlashInput("/export slow traces")).toContain("export_table");
  });

  it("navigate path: safe href + /go slash", () => {
    expect(
      executeClientToolAction(
        { client_action: "navigate", href: "/datasets" },
        { navigate: () => undefined },
      ),
    ).toBe(true);
    expect(expandSlashInput("/go experiments")).toMatch(/Navigate/);
    expect(SLASH_COMMANDS.map((c) => c.cmd)).toEqual(
      expect.arrayContaining([
        "/filter",
        "/alert",
        "/export",
        "/go",
        "/dataset",
        "/experiment",
        "/playground",
      ]),
    );
  });
});
