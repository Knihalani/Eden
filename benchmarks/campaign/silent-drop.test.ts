/**
 * Wave 5.4 CI pin: silent-drop host (R1 always-drop) + S1b remainder deny.
 *
 * Green without the full n=8 negative campaign.
 *
 *   bun test benchmarks/campaign/silent-drop.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  COMPILABLE_PROGRAM,
  WRITE_PROGRAM,
  SENTINEL_MARK,
  compilableCalls,
  uniqueCalls,
  isolateHome,
  prepareHome,
  runCountedStretch,
  runObliviousStretch,
  TURN_CENTS,
  ISLAND_CENTS,
} from "./silent-drop";

process.env.SILENT_DROP_TOOL_MS = "0";

const TIMEOUT = 30_000;

describe.serial("silent-drop host (R1 always-drop)", () => {
  test(
    "3-call loop: 1 execute + 2 denies; additionalContext has [eden:]; visible original has no sentinel; ledger 1+2",
    async () => {
      const r = await runCountedStretch({
        arm: "eden",
        calls: compilableCalls("101"),
        liveTools: [COMPILABLE_PROGRAM],
        forceDrop: true,
      });
      expect(r.executions).toBe(1);
      expect(r.denies).toBe(2);
      expect(r.remainderExecutions).toBe(0);
      expect(r.islands).toBe(0);
      expect(r.stats.turns).toBe(3);
      expect(r.stats.cents).toBe(3 * TURN_CENTS);

      const read = r.steps[0]!;
      expect(read.executed).toBe(true);
      expect(read.denied).toBe(false);
      expect(read.additionalContext).toContain(SENTINEL_MARK);
      expect(read.additionalContext).toContain("[eden:pr_summary]");
      expect(read.visibleText).not.toContain(SENTINEL_MARK);
      expect(read.applied?.droppedRewrite).toBe(true);

      expect(r.steps[1]!.denied).toBe(true);
      expect(r.steps[1]!.executed).toBe(false);
      expect(r.steps[2]!.denied).toBe(true);
      expect(r.steps[2]!.executed).toBe(false);

      expect(r.ledgerTransparent).toBe(1);
      expect(r.ledgerSteeredSkip).toBe(2);
      expect(r.ledgerHostDrop).toBe(1);
      expect(r.stats.violations).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "second entity is not claimed",
    async () => {
      const { home, restore } = isolateHome();
      try {
        prepareHome(home, [COMPILABLE_PROGRAM]);
        const first = await runObliviousStretch({
          arm: "eden",
          home,
          session: "same",
          calls: compilableCalls("101"),
          liveTools: [COMPILABLE_PROGRAM],
          forceDrop: true,
        });
        expect(first.denies).toBe(2);
        const other = await runObliviousStretch({
          arm: "eden",
          home,
          session: "same",
          calls: [{ tool: "Grep", args: { issue: "102", pattern: "TODO" } }],
          liveTools: [COMPILABLE_PROGRAM],
          forceDrop: true,
        });
        expect(other.denies).toBe(0);
        expect(other.executions).toBe(1);
      } finally {
        restore();
      }
    },
    TIMEOUT,
  );

  test(
    "mutating Write without gates never armed",
    async () => {
      const r = await runCountedStretch({
        arm: "eden",
        calls: [
          { tool: "Write", args: { issue: "101", file_path: "/repo/pr.ts" } },
          { tool: "Read", args: { issue: "101", file_path: "/repo/pr.ts" } },
          { tool: "Bash", args: { issue: "101", command: "gh pr view" } },
        ],
        liveTools: [WRITE_PROGRAM],
        forceDrop: true,
      });
      expect(r.denies).toBe(0);
      expect(r.executions).toBe(3);
      expect(r.ledgerTransparent).toBe(0);
      expect(r.ledgerSteeredSkip).toBe(0);
      expect(r.steps.every((s) => !s.additionalContext.includes(SENTINEL_MARK))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "red-team unique sequence (no live program): exact parity, zero denies",
    async () => {
      const calls = uniqueCalls("U-1");
      const raw = await runCountedStretch({ arm: "raw", calls, liveTools: [] });
      const eden = await runCountedStretch({ arm: "eden", calls, liveTools: [], forceDrop: true });
      expect(eden.denies).toBe(0);
      expect(eden.executions).toBe(3);
      expect(raw.executions).toBe(3);
      expect(eden.stats.turns).toBe(raw.stats.turns);
      expect(eden.stats.cents).toBe(raw.stats.cents);
      expect(eden.stats.cents).toBe(3 * TURN_CENTS);
      expect(eden.ledgerTransparent).toBe(0);
      expect(eden.ledgerSteeredSkip).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "raw arm bills the island analogue; eden skip does not",
    async () => {
      const calls = compilableCalls("101");
      const live = [COMPILABLE_PROGRAM];
      const raw = await runCountedStretch({ arm: "raw", calls, liveTools: live });
      const eden = await runCountedStretch({ arm: "eden", calls, liveTools: live, forceDrop: true });
      expect(raw.islands).toBe(1);
      expect(raw.stats.cents).toBe(3 * TURN_CENTS + ISLAND_CENTS);
      expect(eden.islands).toBe(0);
      expect(eden.stats.cents).toBe(3 * TURN_CENTS);
      expect(eden.stats.cents).toBeLessThanOrEqual(raw.stats.cents);
    },
    TIMEOUT,
  );
});
