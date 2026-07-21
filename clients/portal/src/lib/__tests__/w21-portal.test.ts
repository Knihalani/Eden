/**
 * Wave 21 — ChatSidebar navigate + filters structural / contract tests.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeClientToolAction,
  extractClientAction,
  isSafePortalHref,
} from "@/components/ai-insights/clientToolExecutors";
import {
  expandSlashInput,
  filterSlashCommands,
  SLASH_COMMANDS,
} from "@/components/ai-insights/slashCommands";
import { buildPageContext } from "@/components/ai-insights/types";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");

describe("W21 navigate + filter tools (server)", () => {
  it("registers navigate, propose_filter, find_similar, open_*", () => {
    const tools = py("eden/llmops/insights_tools.py");
    for (const name of [
      "navigate",
      "propose_filter",
      "find_similar",
      "open_trace",
      "open_issue",
      "open_session",
      "open_alert",
      "open_artifact",
    ]) {
      expect(tools).toContain(`name="${name}"`);
    }
    expect(tools).toContain('"client_action": "navigate"');
    expect(tools).toContain('"client_action": "propose_filter"');
    expect(tools).toContain("_safe_portal_href");
  });

  it("PageContext includes rich fields", () => {
    const routes = py("eden/api/routes/ai_insights.py");
    expect(routes).toContain("search:");
    expect(routes).toContain("resource:");
    expect(routes).toContain("issue_id:");
    expect(routes).toContain("selected_id:");
    expect(routes).toContain("propose_filter");
    expect(routes).toContain("open_trace");
  });
});

describe("W21 client executors", () => {
  it("extracts and executes navigate + propose_filter safely", () => {
    expect(isSafePortalHref("/traces?q=x")).toBe(true);
    expect(isSafePortalHref("https://evil.test")).toBe(false);
    expect(isSafePortalHref("//evil")).toBe(false);

    expect(
      extractClientAction({
        client_action: "navigate",
        href: "https://evil.test",
      }),
    ).toBeNull();

    const nav = extractClientAction({
      client_action: "navigate",
      href: "/issues/iss_1",
    });
    expect(nav).toEqual({
      client_action: "navigate",
      href: "/issues/iss_1",
    });

    const navigated: string[] = [];
    expect(
      executeClientToolAction(
        { client_action: "navigate", href: "/traces" },
        { navigate: (h) => navigated.push(h) },
      ),
    ).toBe(true);
    expect(navigated).toEqual(["/traces"]);

    const filtered: string[] = [];
    const events: unknown[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("eden:ai-apply-filter", handler);
    expect(
      executeClientToolAction(
        {
          client_action: "propose_filter",
          q: "status:error",
          href: "/traces?q=status%3Aerror",
        },
        { navigate: (h) => filtered.push(h) },
      ),
    ).toBe(true);
    window.removeEventListener("eden:ai-apply-filter", handler);
    expect(filtered[0]).toContain("/traces");
    expect(events[0]).toMatchObject({ q: "status:error" });
  });

  it("wires tool_result → executeClientToolAction in the hook", () => {
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("executeClientToolAction");
    expect(hook).toContain("eden:ask-ai");
    expect(hook).toContain("ai_prompt");
    expect(hook).toContain('params.get("ai")');
    expect(hook).toContain("expandSlashInput");
    expect(hook).toContain("buildPageContext");
  });
});

describe("W21 slash + @ + page_context + coach", () => {
  it("expands slash commands /filter|/similar|/go", () => {
    expect(SLASH_COMMANDS.map((c) => c.cmd).sort()).toEqual(
      [
        "/alert",
        "/dataset",
        "/experiment",
        "/export",
        "/filter",
        "/go",
        "/playground",
        "/signal",
        "/similar",
        "/sql",
      ].sort(),
    );
    expect(expandSlashInput("/filter latency:>2")).toContain("latency:>2");
    expect(expandSlashInput("/similar")).toMatch(/similar/i);
    expect(expandSlashInput("/go traces")).toContain("/traces");
    expect(filterSlashCommands("/fi").some((c) => c.cmd === "/filter")).toBe(true);
    expect(expandSlashInput("hello")).toBeNull();
  });

  it("Composer has slash + @ picker", () => {
    const composer = src("components/ai-insights/Composer.tsx");
    expect(composer).toContain("filterSlashCommands");
    expect(composer).toContain("filterMentions");
    expect(composer).toContain("/filter");
    expect(composer).toContain("@trace");
  });

  it("buildPageContext exports rich payload fields", () => {
    const types = src("components/ai-insights/types.ts");
    expect(types).toContain("PageContextPayload");
    expect(types).toContain("selected_id");
    expect(types).toContain("resource");
    expect(types).toContain("issue_id");
    expect(typeof buildPageContext).toBe("function");
    const ctx = buildPageContext("/issues/iss_1");
    expect(ctx.pathname).toBe("/issues/iss_1");
    expect(ctx.resource).toBe("issues");
    expect(ctx.issue_id).toBe("iss_1");
  });

  it("coach mark + Ask AI palette + deep-link surface", () => {
    const shell = src("components/ai-insights/ChatSidebar.tsx");
    expect(shell).toContain("data-ai-coach-mark");
    expect(shell).toContain("Tooltip");
    expect(shell).toContain("Ask Eden AI");
    expect(shell).toContain("header Ask AI icon");
    expect(shell).toContain("!chat.isMobile");
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/clientToolExecutors.ts"))).toBe(
      true,
    );
    expect(existsSync(resolve(ROOT, "src/components/ai-insights/slashCommands.ts"))).toBe(
      true,
    );
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain("showCoach");
    expect(hook).toContain("eden:ai-coach-seen");
    expect(hook).toContain("setShowCoach(true)");
    const nav = src("lib/nav-commands.ts");
    expect(nav).toContain('label: "Ask AI"');
    expect(nav).toContain("header · FAB · ⌘K/⌘J");
    const palette = src("components/ui/command-palette.tsx");
    expect(palette).toContain("eden:ask-ai");
  });
});

describe("W21 filter+navigate contract path", () => {
  it("propose_filter → event + router path is end-to-end wired", () => {
    const hook = src("components/ai-insights/hooks/useChatSidebar.ts");
    expect(hook).toContain('case "tool_result"');
    expect(hook).toContain("navigateRef");
    const exec = src("components/ai-insights/clientToolExecutors.ts");
    expect(exec).toContain("eden:ai-apply-filter");
    expect(exec).toContain('client_action: "propose_filter"');

    const navigate = vi.fn();
    executeClientToolAction(
      { client_action: "propose_filter", q: "agent:support" },
      { navigate },
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.stringContaining("agent%3Asupport"),
    );
  });
});
