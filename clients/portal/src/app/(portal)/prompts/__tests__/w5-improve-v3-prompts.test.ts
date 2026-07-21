/**
 * Wave 5 — Improve V3 Prompts core (lifecycle + playground bridge).
 * 5.1 master–detail ≥1280 / drawer · 5.2 Draft/Published/Env-pinned + rollback
 * honesty · 5.3 Open in Playground · 5.4 prompt_update scent · 5.5 table-first
 * · 5.6 no Studio merge · marker data-wave5-improve-prompts.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  derivePromptLifecycle,
  LIFECYCLE_HONESTY,
  LIFECYCLE_LABELS,
} from "../_components/prompt-lifecycle";
import { promptHref, promptPlaygroundHref } from "@/lib/portal-cross-links";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 5.1 — list|editor master–detail", () => {
  it("uses ResourcePageShell + DetailPanelShell (≥1280 split / drawer)", () => {
    const page = read("app/(portal)/prompts/page.tsx");
    expect(page).toContain("ResourcePageShell");
    expect(page).toContain("DetailPanelShell");
    expect(page).toContain('data-testid="prompts-master-detail"');
    expect(page).toContain('data-wave5-improve-prompts="completed"');
    expect(page.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("deep-links selection via ?prompt=", () => {
    const page = read("app/(portal)/prompts/page.tsx");
    expect(page).toContain('searchParams.get("prompt")');
    expect(page).toContain("promptHref");
    expect(promptHref("support_reply")).toBe("/prompts?prompt=support_reply");
  });
});

describe("Wave 5.2 — lifecycle states + honesty", () => {
  it("derives Draft / Published / Env-pinned", () => {
    expect(derivePromptLifecycle({ versionCount: 0, envPinCount: 0 })).toBe("draft");
    expect(
      derivePromptLifecycle({ versionCount: 1, envPinCount: 0, versionDirty: true }),
    ).toBe("draft");
    expect(derivePromptLifecycle({ versionCount: 2, envPinCount: 0 })).toBe("published");
    expect(derivePromptLifecycle({ versionCount: 2, envPinCount: 1 })).toBe("env_pinned");
    expect(LIFECYCLE_LABELS.draft).toBe("Draft");
    expect(LIFECYCLE_LABELS.published).toBe("Published");
    expect(LIFECYCLE_LABELS.env_pinned).toBe("Env-pinned");
  });

  it("ships honest publish/rollback copy (no fake APIs)", () => {
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    const envs = read("components/prompts/PromptEnvironmentsPanel.tsx");
    expect(editor).toContain("LIFECYCLE_HONESTY");
    expect(editor).toContain('data-testid="prompts-lifecycle-honesty"');
    expect(editor).toContain('data-testid="prompts-rollback"');
    expect(envs).toContain("no separate rollback API");
    expect(envs).toContain('data-testid="prompts-env-rollback"');
    expect(LIFECYCLE_HONESTY.publish).toMatch(/no separate publish/i);
    expect(LIFECYCLE_HONESTY.rollback).toMatch(/no dedicated rollback/i);
  });
});

describe("Wave 5.3 — Open in Playground bridge", () => {
  it("links to /evals?tab=playgrounds with prompt name when possible", () => {
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(editor).toContain("promptPlaygroundHref(name)");
    expect(editor).toContain("Open in Playground");
    expect(editor).toContain('data-testid="prompts-open-playground"');
    expect(promptPlaygroundHref()).toBe("/evals?tab=playgrounds");
    expect(promptPlaygroundHref("support_reply")).toBe(
      "/evals?tab=playgrounds&prompt=support_reply",
    );
  });
});

describe("Wave 5.4 — Improve prompt_update scent", () => {
  it("scents prompt_update plans from editor + PlanKindBadge → /prompts", () => {
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(editor).toContain('data-testid="prompts-improve-scent"');
    expect(editor).toContain("/improve?tab=plans");
    expect(editor).toContain("prompt_update plans");
    const badge = read("components/improve/plan-kind-badge.tsx");
    expect(badge).toContain("prompt_update");
    expect(badge).toContain("promptHref");
    expect(badge).toContain("<Link");
  });
});

describe("Wave 5.5 — table-first density", () => {
  it("uses DataTable list not card grid", () => {
    const list = read("app/(portal)/prompts/_components/prompts-list-table.tsx");
    const page = read("app/(portal)/prompts/page.tsx");
    expect(list).toContain("DataTable");
    expect(list).toContain('data-testid="prompts-version-list"');
    expect(page).toContain("PromptsListTable");
    expect(page).not.toMatch(/grid-cols-\[minmax\(16rem/);
  });
});

describe("Wave 5.6 — no Studio merge + critic", () => {
  it("keeps Studio out of prompts and ships critic", () => {
    const page = read("app/(portal)/prompts/page.tsx");
    expect(page).toMatch(/do not merge with Studio/i);
    expect(page).not.toContain("/studio");
    expect(page).toContain('data-testid="prompts-related-strip"');
    for (const href of ["/issues", "/improve", "/artifacts", "/ledger"]) {
      expect(page).toContain(`href="${href}"`);
    }
    const critic = resolve(portalSrc, "../.wave5-improve-critic.md");
    expect(existsSync(critic)).toBe(true);
    expect(readFileSync(critic, "utf8")).toMatch(/Wave 5/i);
  });
});
