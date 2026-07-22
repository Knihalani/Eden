/**
 * Phase 6 AI Agent contract — surfaces/ai-agent.md acceptance.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = path.resolve(__dirname, "../../../..");
const agentRoot = path.join(portalSrc, "app/(portal)/agent");
const aiAgentComponents = path.join(portalSrc, "components/ai-agent");
const libRoot = path.join(portalSrc, "lib");
const messagesEn = path.join(portalSrc, "messages/en.json");
const messagesDe = path.join(portalSrc, "messages/de.json");
const sidebarConfig = path.join(libRoot, "sidebar-config.ts");
const nextConfig = path.resolve(portalSrc, "../../next.config.ts");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("rebuild AI Agent contract", () => {
  it("/agent page and loading exist", () => {
    expect(existsSync(path.join(agentRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(agentRoot, "loading.tsx"))).toBe(true);
  });

  it("AI Agent component directory has required modules", () => {
    const required = [
      "types.ts",
      "use-ai-session.ts",
      "ai-session-provider.tsx",
      "ai-bubble.tsx",
      "message-stream.tsx",
      "composer.tsx",
      "citation-chip.tsx",
      "action-card.tsx",
      "context-panel.tsx",
      "thread-list.tsx",
      "suggested-prompts.tsx",
    ];
    for (const f of required) {
      expect(existsSync(path.join(aiAgentComponents, f))).toBe(true);
    }
  });

  it("pure lib files exist", () => {
    expect(existsSync(path.join(libRoot, "context-model.ts"))).toBe(true);
    expect(existsSync(path.join(libRoot, "citation-href.ts"))).toBe(true);
  });

  it("sidebar agent href is /agent (not /_stub/agent)", () => {
    const config = read(sidebarConfig);
    expect(config).toContain('href: "/agent"');
    expect(config).not.toContain('href: "/_stub/agent"');
  });

  it("STUB_SURFACE_IDS excludes agent (Phase 6 live; Phase 7 audit/settings still stubbed)", () => {
    const config = read(sidebarConfig);
    expect(config).toContain("STUB_SURFACE_IDS");
    // agent is no longer stubbed (Phase 6 live)
    const stubBlock = config.match(/STUB_SURFACE_IDS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/)?.[1] ?? "";
    expect(stubBlock).not.toContain('"agent"');
    expect(config).not.toContain('href: "/_stub/agent"');
  });

  it("AiSessionProvider is in providers.tsx", () => {
    const providers = read(path.join(portalSrc, "app/(portal)/providers.tsx"));
    expect(providers).toContain("AiSessionProvider");
  });

  it("AppShell wires AiBubble (not link to /_stub/agent)", () => {
    const shell = read(path.join(portalSrc, "components/shell/app-shell.tsx"));
    expect(shell).toContain("AiBubble");
    expect(shell).not.toContain('href="/_stub/agent"');
  });

  it("PortalHeader Ask opens bubble (not link to /_stub/agent)", () => {
    const header = read(path.join(portalSrc, "components/shell/portal-header.tsx"));
    expect(header).toContain("openAi");
    expect(header).not.toContain("/_stub/agent");
  });

  it("CommandPalette has Open AI and Debugger entries", () => {
    const palette = read(path.join(portalSrc, "components/ui/command-palette.tsx"));
    expect(palette).toContain("openAi");
    expect(palette).toContain("eden:ask-ai");
    expect(palette).toContain('"/debugger"');
  });

  it("citation-href maps all citation kinds to canonical hrefs", () => {
    const citationHref = read(path.join(libRoot, "citation-href.ts"));
    expect(citationHref).toContain('"trace"');
    expect(citationHref).toContain('"issue"');
    expect(citationHref).toContain('"plan"');
    expect(citationHref).toContain('"debuggerSession"');
    expect(citationHref).toContain("/traces?");
    expect(citationHref).toContain("/issues?");
    expect(citationHref).toContain("/debugger/");
  });

  it("action-card gates mutate CTAs for viewer role", () => {
    const card = read(path.join(aiAgentComponents, "action-card.tsx"));
    expect(card).toContain("canMutate");
    expect(card).toContain("viewer");
    expect(card).toContain("usePermissions");
  });

  it("ai_autosend default 0 — not auto-sent in provider", () => {
    const provider = read(path.join(aiAgentComponents, "ai-session-provider.tsx"));
    expect(provider).not.toContain("ai_autosend=1");
    // No auto-send on mount — sendMessage must not be invoked inside useEffect
    expect(provider).not.toContain("sendMessage(");
  });

  it("no permanent right-rail EmbeddedSurface / dual rail", () => {
    const shell = read(path.join(portalSrc, "components/shell/app-shell.tsx"));
    expect(shell).not.toContain("EmbeddedSurface");
    expect(shell).not.toContain("AiRailHost");
    expect(shell).not.toContain("permanent");
  });

  it("no softLand for /agent in next.config.ts", () => {
    if (!existsSync(nextConfig)) return;
    const config = read(nextConfig);
    const softLandBlock = config.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBlock).not.toContain('"/agent"');
  });

  it("i18n ai namespace in en and de", () => {
    const en = JSON.parse(read(messagesEn)) as Record<string, unknown>;
    const de = JSON.parse(read(messagesDe)) as Record<string, unknown>;
    expect(en.ai).toBeTruthy();
    expect(de.ai).toBeTruthy();
  });

  it("nav.leaves.agent = 'AI Agent' in en; nav.leaves.agents = 'Agents' — no collision", () => {
    const en = JSON.parse(read(messagesEn)) as Record<string, unknown>;
    const leaves = (en.nav as Record<string, unknown>).leaves as Record<string, string>;
    expect(leaves.agent).toBe("AI Agent");
    expect(leaves.agents).toBe("Agents");
    expect(leaves.agent).not.toBe(leaves.agents);
  });

  it("nav.leaves.agent != nav.leaves.agents in de — disambiguation", () => {
    const de = JSON.parse(read(messagesDe)) as Record<string, unknown>;
    const leaves = (de.nav as Record<string, unknown>).leaves as Record<string, string>;
    expect(leaves.agent).toBeTruthy();
    expect(leaves.agents).toBeTruthy();
    expect(leaves.agent).not.toBe(leaves.agents);
  });
});
