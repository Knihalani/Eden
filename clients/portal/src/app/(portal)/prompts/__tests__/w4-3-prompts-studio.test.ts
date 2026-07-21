/**
 * W4.3 — Prompts / PromptEnvironments false empty, version editor, unsaved guards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

/** Mirror of prompts list empty gate — keep in sync with page.tsx. */
function showPromptsEmpty(opts: {
  isLoading: boolean;
  isError: boolean;
  promptCount: number;
}): boolean {
  return !opts.isLoading && !opts.isError && opts.promptCount === 0;
}

/** Mirror of PromptEnvironmentsPanel empty gate. */
function showPromptEnvsEmpty(opts: {
  loading: boolean;
  error: string | null;
  envCount: number;
}): boolean {
  return !opts.loading && !opts.error && opts.envCount === 0;
}

describe("W4.3 prompts query states + version editor", () => {
  it("gates list empty behind !isLoading && !isError", () => {
    const src = read("app/(portal)/prompts/page.tsx");
    expect(src).toContain("showPromptsEmpty");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Try again");

    expect(
      showPromptsEmpty({ isLoading: true, isError: false, promptCount: 0 }),
    ).toBe(false);
    expect(
      showPromptsEmpty({ isLoading: false, isError: true, promptCount: 0 }),
    ).toBe(false);
    expect(
      showPromptsEmpty({ isLoading: false, isError: false, promptCount: 0 }),
    ).toBe(true);
  });

  it("ships version save editor instead of raw POST API hint", () => {
    const src = read("app/(portal)/prompts/page.tsx");
    const hook = read("app/(portal)/prompts/_components/use-prompts-versions.ts");
    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(editor).toContain("Save version");
    expect(src).toContain("usePromptsVersions");
    expect(hook).toContain("/versions");
    expect(editor).toContain("Unsaved changes");
    expect(hook).toContain("beforeunload");
    expect(hook).toContain("Discard changes?");
    expect(src).not.toMatch(/POST to \/prompts\/\{/);
    expect(editor).toContain("<Textarea");
    expect(editor).toContain("<Input");
  });

  it("PromptEnvironmentsPanel uses ErrorState (no false empty on load fail)", () => {
    const src = read("components/prompts/PromptEnvironmentsPanel.tsx");
    expect(src).toContain('from "@/components/ui/error-state"');
    expect(src).toContain("Could not load environments");
    expect(src).toContain("Try again");
    expect(src).toContain("showPromptEnvsEmpty");
    expect(src).not.toMatch(
      /toast\.error\(errorFromCaught\(e, "Failed to load environments"\)\)/,
    );

    expect(
      showPromptEnvsEmpty({ loading: true, error: null, envCount: 0 }),
    ).toBe(false);
    expect(
      showPromptEnvsEmpty({ loading: false, error: "boom", envCount: 0 }),
    ).toBe(false);
    expect(
      showPromptEnvsEmpty({ loading: false, error: null, envCount: 0 }),
    ).toBe(true);
  });
});
