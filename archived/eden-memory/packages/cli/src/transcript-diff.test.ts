import { describe, expect, test } from "bun:test";
import {
  applyHookOutput,
  applyOpenCodeAfter,
  applyOpenCodeHostOutput,
  applyCodexAfter,
  applyGeminiAfter,
  modelVisibleText,
} from "./transcript-diff";
import { postToolUseReplacement } from "./transparent";
import { BUILTIN_TOOLS, matchesNativeShape } from "./shapes";

const ORIGINALS: Record<string, unknown> = {
  Bash: { stdout: "ok", stderr: "", interrupted: false, isImage: false },
  Read: {
    type: "text",
    file: { filePath: "/a.ts", content: "hi", numLines: 1, startLine: 1, totalLines: 1 },
  },
  WebFetch: { bytes: 2, code: 200, codeText: "OK", result: "body", durationMs: 1, url: "https://x.test" },
  Glob: { filenames: ["a.ts"], durationMs: 1, numFiles: 1, truncated: false },
  Grep: { mode: "content", numFiles: 1, filenames: ["a.ts"], content: "hit", numLines: 1 },
  Write: { type: "create", filePath: "/a.ts", content: "x", structuredPatch: [], originalFile: "" },
};

describe("transcript-diff headless host (Claude Code silent drop)", () => {
  test("string rewrite for Read is DROPPED; additionalContext survives", () => {
    const orig = ORIGINALS.Read;
    const applied = applyHookOutput("Read", orig, {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: "bare string [eden:pr_summary] facts",
        additionalContext: "[eden:pr_summary] The remaining steps were already served.",
      },
    });
    expect(applied.droppedRewrite).toBe(true);
    expect(applied.visible).toEqual(orig);
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("Read", applied)).toContain("[eden:pr_summary]");
  });

  test("object rewrite for Read LANDS with sentinel in file.content", () => {
    const orig = ORIGINALS.Read;
    const hook = postToolUseReplacement("Read", orig, "facts", "pr_summary");
    const applied = applyHookOutput("Read", orig, hook);
    expect(applied.droppedRewrite).toBe(false);
    expect(matchesNativeShape("Read", applied.visible)).toBe(true);
    const file = (applied.visible as { file: { content: string; filePath: string } }).file;
    expect(file.filePath).toBe("/a.ts");
    expect(file.content).toContain("[eden:pr_summary]");
    expect(modelVisibleText("Read", applied)).toContain("[eden:pr_summary]");
  });

  test("additionalContext survives a dropped rewrite under decision:block", () => {
    const orig = ORIGINALS.Read;
    const applied = applyHookOutput("Read", orig, {
      decision: "block",
      hookSpecificOutput: {
        updatedToolOutput: "string rewrite",
        additionalContext: "[eden:pr_summary] facts still attached",
      },
    });
    expect(applied.droppedRewrite).toBe(true);
    expect(applied.visible).toEqual(orig);
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
  });

  test("every built-in object rewrite is applied and model-visible text contains the sentinel", () => {
    for (const tool of BUILTIN_TOOLS) {
      const orig = ORIGINALS[tool]!;
      const hook = postToolUseReplacement(tool, orig, "facts", "pr_summary");
      const applied = applyHookOutput(tool, orig, hook);
      expect(applied.droppedRewrite).toBe(false);
      expect(matchesNativeShape(tool, applied.visible)).toBe(true);
      expect(modelVisibleText(tool, applied)).toContain("[eden:pr_summary]");
    }
  });

  test("unknown MCP tool: string rewrite lands; additionalContext keeps the sentinel if the host drops it", () => {
    const orig = "vendor-body";
    const hook = postToolUseReplacement("mcp__vendor__thing", orig, "facts", "pr_summary");
    const landed = applyHookOutput("mcp__vendor__thing", orig, hook);
    expect(landed.droppedRewrite).toBe(false);
    expect(typeof landed.visible).toBe("string");
    expect(String(landed.visible)).toContain("[eden:pr_summary]");
    expect(landed.additionalContext).toContain("[eden:pr_summary]");

    const dropped = applyHookOutput("mcp__vendor__thing", orig, {
      hookSpecificOutput: {
        additionalContext: (hook as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
          .additionalContext,
      },
    });
    expect(dropped.visible).toBe(orig);
    expect(dropped.additionalContext).toContain("[eden:pr_summary]");
  });
});

describe("transcript-diff OpenCode / Codex / Gemini", () => {
  test("OpenCode native after: string rewrite lands in output; sentinel is model-visible", () => {
    const orig = "export {}";
    const hook = postToolUseReplacement("Read", orig, "facts", "pr_summary");
    const applied = applyOpenCodeAfter("read", orig, hook);
    expect(applied.droppedRewrite).toBe(false);
    expect(typeof applied.visible).toBe("string");
    expect(String(applied.visible)).toContain("[eden:pr_summary]");
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("read", applied)).toContain("[eden:pr_summary]");
  });

  test("OpenCode native bash maps to Bash stdout merge", () => {
    const orig = "reviews=6";
    const hook = postToolUseReplacement("Bash", orig, "facts", "pr_summary");
    const applied = applyOpenCodeAfter("bash", orig, hook);
    expect(applied.droppedRewrite).toBe(false);
    expect(String(applied.visible)).toContain("reviews=6");
    expect(String(applied.visible)).toContain("[eden:pr_summary]");
  });

  test("OpenCode MCP-shaped after payload: output.output mutation is dropped; additionalContext kept", () => {
    const orig = { content: [{ type: "text", text: "vendor-body" }] };
    const hook = postToolUseReplacement("mcp__vendor__thing", orig, "facts", "pr_summary");
    const applied = applyOpenCodeAfter("mcp__vendor__thing", orig, hook);
    expect(applied.droppedRewrite).toBe(true);
    expect(applied.visible).toEqual(orig);
    expect(JSON.stringify(applied.visible)).not.toContain("[eden:pr_summary]");
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("mcp__vendor__thing", applied)).toContain("[eden:pr_summary]");
  });

  test("OpenCode host output mutates output.output for native; inject-only on MCP drop", () => {
    const native = { output: "ok", title: "bash" };
    const hook = postToolUseReplacement("Bash", "ok", "facts", "pr_summary");
    applyOpenCodeHostOutput(native, "bash", hook);
    expect(String(native.output)).toContain("[eden:pr_summary]");

    const mcp = { output: { content: [{ type: "text", text: "body" }] }, inject: "" };
    applyOpenCodeHostOutput(mcp, "mcp__x", hook);
    expect(mcp.output).toEqual({ content: [{ type: "text", text: "body" }] });
    expect(String(mcp.inject)).toContain("[eden:pr_summary]");
  });

  test("Codex post_tool stdout is Claude-like JSON; string originals land rewrite text", () => {
    const orig = "reviews=6";
    const hook = postToolUseReplacement("Bash", orig, "facts", "pr_summary");
    expect(hook).toHaveProperty("hookSpecificOutput.updatedToolOutput.stdout");
    const applied = applyCodexAfter("Bash", orig, hook);
    expect(applied.droppedRewrite).toBe(false);
    expect(String(applied.visible)).toContain("[eden:pr_summary]");
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
  });

  test("Codex object originals follow Claude R1; Glob text-less degrades to additionalContext", () => {
    const bashOrig = ORIGINALS.Bash;
    const bashHook = postToolUseReplacement("Bash", bashOrig, "facts", "pr_summary");
    const bashApplied = applyCodexAfter("Bash", bashOrig, bashHook);
    expect(bashApplied.droppedRewrite).toBe(false);
    expect(matchesNativeShape("Bash", bashApplied.visible)).toBe(true);

    const globOrig = "a.ts\nb.ts";
    const globHook = postToolUseReplacement("Glob", ORIGINALS.Glob, "facts", "pr_summary");
    const globApplied = applyCodexAfter("Glob", globOrig, globHook);
    expect(globApplied.droppedRewrite).toBe(true);
    expect(globApplied.visible).toBe(globOrig);
    expect(globApplied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("Glob", globApplied)).toContain("[eden:pr_summary]");
  });

  test("Gemini AfterToolUse: updatedToolOutput dropped, additionalContext lands the sentinel", () => {
    const orig = { llmContent: "body", returnDisplay: "body" };
    const hook = postToolUseReplacement("Bash", "body", "facts", "pr_summary");
    const applied = applyGeminiAfter("run_shell_command", orig, hook);
    expect(applied.droppedRewrite).toBe(true);
    expect(applied.visible).toEqual(orig);
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("Bash", applied)).toContain("[eden:pr_summary]");
  });
});
