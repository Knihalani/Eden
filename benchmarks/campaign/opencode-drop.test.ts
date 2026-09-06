/**
 * Wave 11 CI pin: OpenCode MCP-shaped after-hook drop + S1b remainder deny.
 *
 *   bun test benchmarks/campaign/opencode-drop.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  COMPILABLE_PROGRAM,
  EXPECT,
  SENTINEL_MARK,
  compilableCalls,
  mcpShapedResult,
  runOpenCodeStretch,
} from "./opencode-drop";
import { applyOpenCodeAfter } from "../../packages/cli/src/transcript-diff";
import { postToolUseReplacement } from "../../packages/cli/src/transparent";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 30_000;

describe.serial("opencode-drop host (MCP-shaped after payload)", () => {
  test("pre-registered expect names a new class, not silent-drop", () => {
    expect(EXPECT).toContain("MCP-shaped");
    expect(EXPECT).toContain("remainder deny");
    expect(EXPECT).not.toContain("updatedToolOutput");
  });

  test(
    "native 3-call loop: rewrite lands in output.output; 1 execute + 2 denies; no host-drop",
    async () => {
      const r = await runOpenCodeStretch({ firstResult: "native" });
      expect(r.executions).toBe(1);
      expect(r.denies).toBe(2);
      expect(r.remainderExecutions).toBe(0);
      expect(r.droppedRewrites).toBe(0);

      const read = r.steps[0]!;
      expect(read.executed).toBe(true);
      expect(read.visibleText).toContain(SENTINEL_MARK);
      expect(read.additionalContext).toContain("[eden:pr_summary]");
      expect(read.applied?.droppedRewrite).toBe(false);

      expect(r.steps[1]!.denied).toBe(true);
      expect(r.steps[2]!.denied).toBe(true);
      expect(r.ledgerTransparent).toBe(1);
      expect(r.ledgerSteeredSkip).toBe(2);
      expect(r.ledgerHostDrop).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "MCP-shaped first call: rewrite dropped, additionalContext has sentinel, remainder deny still holds",
    async () => {
      const r = await runOpenCodeStretch({ firstResult: "mcp" });
      expect(r.executions).toBe(1);
      expect(r.denies).toBe(2);
      expect(r.remainderExecutions).toBe(0);
      expect(r.droppedRewrites).toBe(1);

      const read = r.steps[0]!;
      expect(read.applied?.droppedRewrite).toBe(true);
      expect(read.visibleText).not.toContain(SENTINEL_MARK);
      expect(read.visibleText).toContain('"content"');
      expect(read.additionalContext).toContain("[eden:pr_summary]");
      expect(r.steps[1]!.denied).toBe(true);
      expect(r.steps[2]!.denied).toBe(true);
      expect(r.ledgerTransparent).toBe(1);
      expect(r.ledgerSteeredSkip).toBe(2);
      expect(r.ledgerHostDrop).toBe(1);
    },
    TIMEOUT,
  );

  test("MCP-shaped applyOpenCodeAfter keeps original content[] and does not retune silent-drop", () => {
    const orig = mcpShapedResult("vendor-body");
    const hook = postToolUseReplacement("mcp__vendor__thing", orig, "facts", "pr_summary");
    const applied = applyOpenCodeAfter("mcp__vendor__thing", orig, hook);
    expect(applied.droppedRewrite).toBe(true);
    expect(applied.visible).toEqual(orig);
    expect(applied.additionalContext).toContain(SENTINEL_MARK);
    expect(compilableCalls()[0]!.tool).toBe("read");
    expect(COMPILABLE_PROGRAM.sequence).toEqual(["Read", "Grep", "Bash"]);
  });
});
