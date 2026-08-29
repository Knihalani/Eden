import { describe, expect, test } from "bun:test";
import {
  eligibleForTransparent,
  executeTransparent,
  inSessionBucket,
  postToolUseReplacement,
  transparencyEnabled,
  writesGateOpen,
  type LiveTool,
} from "./transparent";
import { applyHookOutput, modelVisibleText } from "./transcript-diff";
import { BUILTIN_TOOLS, matchesNativeShape } from "./shapes";

const readOnlyTool: LiveTool = {
  name: "pr_summary",
  sequence: ["Bash", "Bash", "Bash"],
  id: "t1",
  read_only: true,
  envelope: { inputs: { issue: ["101", "102"] } },
};

const writeTool: LiveTool = {
  name: "patch_pr",
  sequence: ["Read", "Write"],
  id: "t-w",
  read_only: false,
  transparent_writes: true,
};

const ORIGINALS: Record<string, unknown> = {
  Bash: { stdout: '{"state":"pending"}', stderr: "", interrupted: false, isImage: false },
  Read: {
    type: "text",
    file: { filePath: "/repo/pr.ts", content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
  },
  WebFetch: { bytes: 12, code: 200, codeText: "OK", result: "body", durationMs: 8, url: "https://example.test" },
  Glob: { filenames: ["a.ts", "b.ts"], durationMs: 3, numFiles: 2, truncated: false },
  Grep: { mode: "content", numFiles: 1, filenames: ["a.ts"], content: "match", numLines: 1 },
  Write: { type: "update", filePath: "/repo/a.ts", content: "new", structuredPatch: [], originalFile: "old" },
};

describe("transparent execution (surfacing without a surface)", () => {
  test("eligible only for attested read-only programs with ≥2 steps and in-distribution input", () => {
    process.env.EDEN_TRANSPARENT = "1"; // config-independent eligibility check
    expect(eligibleForTransparent(readOnlyTool, { issue: "101" })).toBe(true);
    expect(eligibleForTransparent(readOnlyTool, { issue: "101", file_path: "/repo/pr.ts" })).toBe(true);
    // unknown read-only ⇒ fail closed
    expect(eligibleForTransparent({ ...readOnlyTool, read_only: undefined }, { issue: "101" })).toBe(false);
    // single-step programs have no remainder to serve
    expect(eligibleForTransparent({ ...readOnlyTool, sequence: ["Bash"] }, { issue: "101" })).toBe(false);
    // out-of-distribution input never triggers
    expect(eligibleForTransparent(readOnlyTool, { issue: "999" })).toBe(false);
  });

  test("canary serves empty session and hashed bucket; missing rollout stays 100%", () => {
    expect(inSessionBucket({ rollout: "canary" }, "")).toBe(true);
    expect(inSessionBucket({ rollout: "canary" }, undefined)).toBe(true);
    expect(inSessionBucket({}, "sess-1")).toBe(true);
    expect(inSessionBucket({ rollout: "live" }, "sess-1")).toBe(true);
    let out = "";
    for (let i = 0; i < 400 && !out; i++) if (!inSessionBucket({ rollout: "canary" }, `sess-${i}`)) out = `sess-${i}`;
    expect(out).toBeTruthy();
    expect(inSessionBucket({ rollout: "canary" }, out)).toBe(false);
  });

  test("kill switch: EDEN_TRANSPARENT=0 or transparent_exec:false disables entirely", () => {
    const prev = process.env.EDEN_TRANSPARENT;
    process.env.EDEN_TRANSPARENT = "0";
    expect(transparencyEnabled({ api_key: "k", base_url: "b", transparent_exec: true } as never)).toBe(false);
    delete process.env.EDEN_TRANSPARENT;
    expect(transparencyEnabled({ api_key: "k", base_url: "b" } as never)).toBe(true);
    expect(transparencyEnabled({ api_key: "k", base_url: "b", transparent_exec: false } as never)).toBe(false);
    if (prev === undefined) delete process.env.EDEN_TRANSPARENT;
    else process.env.EDEN_TRANSPARENT = prev;
  });

  test("executeTransparent fails open on unreachable plane / bad response / timeout", async () => {
    const prevBase = process.env.EDEN_BASE_URL;
    process.env.EDEN_BASE_URL = "http://127.0.0.1:1"; // nothing listening
    try {
      expect(await executeTransparent(readOnlyTool, { issue: "101" })).toBeNull();
    } finally {
      if (prevBase === undefined) delete process.env.EDEN_BASE_URL;
      else process.env.EDEN_BASE_URL = prevBase;
    }
  });

  test("replacement uses Bash's NATIVE result shape ({stdout,stderr,interrupted}) — bare strings are silently dropped by the harness", () => {
    const out = postToolUseReplacement(
      "Bash",
      '{"state":"pending"}',
      "reviews=6 | status=pending | files=14",
      "pr_summary",
    ) as {
      hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
        updatedToolOutput: { stdout: string; stderr: string; interrupted: boolean; isImage?: boolean };
      };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const u = out.hookSpecificOutput.updatedToolOutput;
    // Shape is the whole point: a plain string here would be silently ignored.
    expect(typeof u).toBe("object");
    expect(u.stderr).toBe("");
    expect(u.interrupted).toBe(false);
    expect(u.isImage).toBe(false);
    expect(u.stdout.startsWith('{"state":"pending"}')).toBe(true); // original intact
    expect(u.stdout).toContain("[eden:pr_summary]");
    expect(u.stdout).toContain("Do not re-run this routine");
    expect(u.stdout).toContain("reviews=6 | status=pending | files=14");
    expect(out.hookSpecificOutput.additionalContext).toContain("[eden:pr_summary]");
    expect(matchesNativeShape("Bash", u)).toBe(true);
  });

  test("unknown tools get the string form plus additionalContext; oversized merges are honestly truncated under the 10k cap", () => {
    const out = postToolUseReplacement("mcp__github__search", "original", "facts") as {
      hookSpecificOutput: { updatedToolOutput: string; additionalContext: string };
    };
    expect(typeof out.hookSpecificOutput.updatedToolOutput).toBe("string");
    expect(out.hookSpecificOutput.updatedToolOutput).toContain("[eden:mcp__github__search]");
    expect(out.hookSpecificOutput.additionalContext).toContain("[eden:mcp__github__search]");

    const big = "x".repeat(12_000);
    const capped = postToolUseReplacement("Bash", big, "facts", "pr_summary") as {
      hookSpecificOutput: { updatedToolOutput: { stdout: string } };
    };
    const text = capped.hookSpecificOutput.updatedToolOutput.stdout;
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("[eden truncated");
    expect(text).toContain("[eden:pr_summary]");
    expect(text.endsWith("complete.")).toBe(true);
  });

  test("every built-in gets a native object (never a bare string) with sentinel in model-visible text", () => {
    for (const tool of BUILTIN_TOOLS) {
      const orig = ORIGINALS[tool]!;
      const hook = postToolUseReplacement(tool, orig, "reviews=6", "pr_summary") as {
        hookSpecificOutput: { updatedToolOutput: unknown; additionalContext: string };
      };
      const u = hook.hookSpecificOutput.updatedToolOutput;
      expect(typeof u).toBe("object");
      expect(u).not.toBeNull();
      expect(matchesNativeShape(tool, u)).toBe(true);
      expect(hook.hookSpecificOutput.additionalContext).toContain("[eden:pr_summary]");
      const applied = applyHookOutput(tool, orig, hook);
      expect(applied.droppedRewrite).toBe(false);
      expect(modelVisibleText(tool, applied)).toContain("[eden:pr_summary]");
    }
  });

  test("Read merges into file.content and preserves filePath", () => {
    const orig = ORIGINALS.Read;
    const hook = postToolUseReplacement("Read", orig, "facts", "pr_summary") as {
      hookSpecificOutput: {
        updatedToolOutput: { type: string; file: { filePath: string; content: string } };
        additionalContext: string;
      };
    };
    const u = hook.hookSpecificOutput.updatedToolOutput;
    expect(u.type).toBe("text");
    expect(u.file.filePath).toBe("/repo/pr.ts");
    expect(u.file.content.startsWith("export {}")).toBe(true);
    expect(u.file.content).toContain("[eden:pr_summary]");
  });

  test("WebFetch merges into result", () => {
    const u = (
      postToolUseReplacement("WebFetch", ORIGINALS.WebFetch, "facts", "pr_summary") as {
        hookSpecificOutput: { updatedToolOutput: { result: string; url: string; code: number } };
      }
    ).hookSpecificOutput.updatedToolOutput;
    expect(u.url).toBe("https://example.test");
    expect(u.code).toBe(200);
    expect(u.result.startsWith("body")).toBe(true);
    expect(u.result).toContain("[eden:pr_summary]");
  });

  test("Glob keeps filenames unchanged; sentinel lives in additionalContext", () => {
    const orig = ORIGINALS.Glob as { filenames: string[] };
    const hook = postToolUseReplacement("Glob", orig, "facts", "pr_summary") as {
      hookSpecificOutput: { updatedToolOutput: { filenames: string[]; durationMs: number }; additionalContext: string };
    };
    expect(hook.hookSpecificOutput.updatedToolOutput.filenames).toEqual(["a.ts", "b.ts"]);
    expect(JSON.stringify(hook.hookSpecificOutput.updatedToolOutput.filenames)).not.toContain("[eden:");
    expect(hook.hookSpecificOutput.additionalContext).toContain("[eden:pr_summary]");
  });

  test("Grep merges into content when present; otherwise additionalContext only", () => {
    const withContent = (
      postToolUseReplacement("Grep", ORIGINALS.Grep, "facts", "pr_summary") as {
        hookSpecificOutput: { updatedToolOutput: { content?: string }; additionalContext: string };
      }
    ).hookSpecificOutput;
    expect(withContent.updatedToolOutput.content).toContain("[eden:pr_summary]");

    const noContentOrig = { mode: "files_with_matches", numFiles: 1, filenames: ["a.ts"] };
    const noContent = postToolUseReplacement("Grep", noContentOrig, "facts", "pr_summary") as {
      hookSpecificOutput: { updatedToolOutput: { content?: string; filenames: string[] }; additionalContext: string };
    };
    expect(noContent.hookSpecificOutput.updatedToolOutput.content).toBeUndefined();
    expect(noContent.hookSpecificOutput.updatedToolOutput.filenames).toEqual(["a.ts"]);
    expect(noContent.hookSpecificOutput.additionalContext).toContain("[eden:pr_summary]");
    expect(matchesNativeShape("Grep", noContent.hookSpecificOutput.updatedToolOutput)).toBe(true);
  });

  test("Write native shape merges into content", () => {
    const u = (
      postToolUseReplacement("Write", ORIGINALS.Write, "facts", "pr_summary") as {
        hookSpecificOutput: {
          updatedToolOutput: { type: string; filePath: string; content: string; structuredPatch: unknown; originalFile: unknown };
        };
      }
    ).hookSpecificOutput.updatedToolOutput;
    expect(u.type).toBe("update");
    expect(u.filePath).toBe("/repo/a.ts");
    expect(u.content).toContain("[eden:pr_summary]");
    expect(u.structuredPatch).toEqual([]);
    expect(u.originalFile).toBe("old");
  });

  test("decision:block still delivers additionalContext with the sentinel (R3)", () => {
    const out = postToolUseReplacement("Bash", "orig", "facts", "pr_summary", { decision: "block" }) as {
      decision?: string;
      hookSpecificOutput: { additionalContext: string; updatedToolOutput: unknown };
    };
    expect(out.decision).toBe("block");
    expect(out.hookSpecificOutput.additionalContext).toContain("[eden:pr_summary]");
    const applied = applyHookOutput("Bash", "orig", out);
    expect(applied.additionalContext).toContain("[eden:pr_summary]");
    expect(modelVisibleText("Bash", applied)).toContain("[eden:pr_summary]");
  });

  test("Write-inclusive serve is dual-gated (env AND tool flag)", () => {
    const prev = process.env.EDEN_TRANSPARENT_WRITES;
    const prevT = process.env.EDEN_TRANSPARENT;
    process.env.EDEN_TRANSPARENT = "1";
    try {
      delete process.env.EDEN_TRANSPARENT_WRITES;
      expect(eligibleForTransparent(writeTool, { issue: "101" })).toBe(false);
      expect(writesGateOpen(writeTool)).toBe(false);

      process.env.EDEN_TRANSPARENT_WRITES = "1";
      expect(eligibleForTransparent(writeTool, { issue: "101" })).toBe(true);
      expect(eligibleForTransparent({ ...writeTool, transparent_writes: false }, { issue: "101" })).toBe(false);
      expect(eligibleForTransparent({ ...writeTool, transparent_writes: undefined }, { issue: "101" })).toBe(false);

      delete process.env.EDEN_TRANSPARENT_WRITES;
      expect(eligibleForTransparent({ ...writeTool, transparent_writes: true }, { issue: "101" })).toBe(false);

      // Shape table still knows Write even when serving is gated off.
      const shaped = postToolUseReplacement("Write", ORIGINALS.Write, "facts", "patch_pr");
      expect(matchesNativeShape("Write", (shaped as { hookSpecificOutput: { updatedToolOutput: unknown } }).hookSpecificOutput.updatedToolOutput)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EDEN_TRANSPARENT_WRITES;
      else process.env.EDEN_TRANSPARENT_WRITES = prev;
      if (prevT === undefined) delete process.env.EDEN_TRANSPARENT;
      else process.env.EDEN_TRANSPARENT = prevT;
    }
  });

  test("hostile facts (__proto__, unicode, nesting) cannot become JSON structure in the hook payload", () => {
    const facts = {
      nested: { a: { b: 1 } },
      unicode: "line\u2028\u0000👾",
    };
    Object.defineProperty(facts, "__proto__", { value: { polluted: true }, enumerable: true });
    const out = postToolUseReplacement("Read", ORIGINALS.Read, facts, "pr_summary");
    const json = JSON.stringify(out);
    expect(json).not.toContain('"polluted"');
    const parsed = JSON.parse(json) as { hookSpecificOutput: { additionalContext: string; updatedToolOutput: { file: { content: string } } } };
    expect(Object.getPrototypeOf(parsed)).not.toHaveProperty("polluted");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("👾");
    expect(ctx).toContain("[eden:pr_summary]");
    expect(ctx.includes("__proto__")).toBe(false);
    expect(parsed.hookSpecificOutput.updatedToolOutput.file.content).toContain("[eden:pr_summary]");
  });
});
