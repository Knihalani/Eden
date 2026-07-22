/**
 * Phase 6–7 AI Agent + Debugger contract (must-ship for rebuild DoD §10).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves, MOBILE_MORE_NAV } from "@/lib/sidebar-config";
import { DEBUGGER_MODES, DEBUGGER_TABS } from "@/lib/debugger-url";

const portalSrc = path.resolve(__dirname, "../../..");
const agentRoot = path.join(portalSrc, "app/(portal)/agent");
const debuggerRoot = path.join(portalSrc, "app/(portal)/debugger");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");
const appShell = path.join(portalSrc, "components/shell/app-shell.tsx");
const aiBubble = path.join(portalSrc, "components/ai-agent/ai-bubble.tsx");

describe("rebuild agent+debugger contract", () => {
  it("live /agent and /debugger routes exist", () => {
    expect(existsSync(path.join(agentRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(debuggerRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(debuggerRoot, "[id]/page.tsx"))).toBe(true);
    expect(existsSync(aiBubble)).toBe(true);
  });

  it("agent label is AI Agent (not Agents) and bubble is wired", () => {
    const leaves = getCoreNavLeaves();
    expect(leaves.find((i) => i.id === "agent")?.href).toBe("/agent");
    expect(leaves.find((i) => i.id === "agents")?.href).toBe("/agents");

    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      nav?: { leaves?: { agent?: string; agents?: string } };
      ai?: { agent?: { title?: string }; bubble?: { title?: string } };
    };
    expect(en.nav?.leaves?.agent).toBe("AI Agent");
    expect(en.nav?.leaves?.agents).toBe("Agents");
    expect(en.ai?.agent?.title).toBe("AI Agent");
    expect(en.ai?.bubble?.title).toBeTruthy();

    const shell = readFileSync(appShell, "utf8");
    expect(shell).toContain("AiBubble");
    expect(shell).not.toContain("/_stub/agent");

    const bubble = readFileSync(aiBubble, "utf8");
    expect(bubble).toContain("data-ai-bubble");
    expect(bubble).toContain("useAiSessionContext");
  });

  it("debugger modes and legacy redirects", () => {
    expect([...DEBUGGER_MODES]).toEqual([
      "replay",
      "compare",
      "time-travel",
      "notes",
    ]);
    expect([...DEBUGGER_TABS]).toContain("sessions");

    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/agent"/);
    expect(softLandBody).not.toMatch(/"\/debugger"/);
    expect(cfg).toMatch(/source: ["']\/debugger-sessions["']/);
    expect(cfg).toMatch(/destination: ["']\/debugger["']/);
    expect(cfg).toMatch(/source: ["']\/replay["']/);
    expect(cfg).toMatch(/destination: ["']\/debugger\?tab=replay["']/);

    const more = MOBILE_MORE_NAV.map((i) => i.href);
    expect(more).toContain("/debugger");
    expect(more).toContain("/agent");
  });

  it("i18n debugger + ai present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      debugger?: { title?: string };
      ai?: { agent?: { title?: string } };
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      debugger?: { title?: string };
      ai?: { agent?: { title?: string } };
    };
    expect(en.debugger?.title).toBeTruthy();
    expect(de.debugger?.title).toBeTruthy();
    expect(en.ai?.agent?.title).toBeTruthy();
    expect(de.ai?.agent?.title).toBeTruthy();
  });
});
