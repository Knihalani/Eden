import { describe, expect, test } from "bun:test";
import {
  eligibleForTransparent,
  executeTransparent,
  postToolUseReplacement,
  transparencyEnabled,
  type LiveTool,
} from "./transparent";

const readOnlyTool: LiveTool = {
  name: "pr_summary",
  sequence: ["Bash", "Bash", "Bash"],
  id: "t1",
  read_only: true,
  envelope: { inputs: { issue: ["101", "102"] } },
};

describe("transparent execution (surfacing without a surface)", () => {
  test("eligible only for attested read-only programs with ≥2 steps and in-distribution input", () => {
    process.env.EDEN_TRANSPARENT = "1"; // config-independent eligibility check
    expect(eligibleForTransparent(readOnlyTool, { issue: "101" })).toBe(true);
    // unknown read-only ⇒ fail closed
    expect(eligibleForTransparent({ ...readOnlyTool, read_only: undefined }, { issue: "101" })).toBe(false);
    // single-step programs have no remainder to serve
    expect(eligibleForTransparent({ ...readOnlyTool, sequence: ["Bash"] }, { issue: "101" })).toBe(false);
    // out-of-distribution input never triggers
    expect(eligibleForTransparent(readOnlyTool, { issue: "999" })).toBe(false);
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
    ) as { hookSpecificOutput: { hookEventName: string; updatedToolOutput: { stdout: string; stderr: string; interrupted: boolean } } };
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    const u = out.hookSpecificOutput.updatedToolOutput;
    // Shape is the whole point: a plain string here would be silently ignored.
    expect(typeof u).toBe("object");
    expect(u.stderr).toBe("");
    expect(u.interrupted).toBe(false);
    expect(u.stdout.startsWith('{"state":"pending"}')).toBe(true); // original intact
    expect(u.stdout).toContain("[eden:pr_summary]");
    expect(u.stdout).toContain("Do not re-run this routine");
    expect(u.stdout).toContain("reviews=6 | status=pending | files=14");
  });

  test("non-Bash tools get the string form; oversized merges are honestly truncated under the 10k cap", () => {
    const out = postToolUseReplacement(
      "mcp__github__search",
      "original",
      "facts",
    ) as { hookSpecificOutput: { updatedToolOutput: string } };
    expect(typeof out.hookSpecificOutput.updatedToolOutput).toBe("string");

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
});
