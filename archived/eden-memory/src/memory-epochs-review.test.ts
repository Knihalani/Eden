/**
 * P1.2 review round 1's probes, kept as regression tests: a rule's packet label is no value token, a rule whose
 * class verb ends its clause keeps an object, and a fork's copied budget is an upper bound.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdSummarized, inheritLedger, ledgerKey, readLedger, recordPacket, startEpoch } from "./memory-ledger";
import { ruleValueTokens } from "./memory-value-tokens";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-p12-probe-"));
  dirs.push(dir);
  return dir;
}
const REPO = "a1b2c3d4e5f60718";
const rule = (text: string) => ({ id: text, text, kind: "constraint" });

describe("probe: value tokens of a rule", () => {
  test("a packet label does not become a value token", () => {
    expect(ruleValueTokens("[rule · 2d · user] Always run the tests with vitest")).toEqual(
      ruleValueTokens("Always run the tests with vitest"),
    );
  });

  test("a rule whose class verb ends its clause keeps an object: the class alone is not its value", () => {
    const tokens = ruleValueTokens("Run the tests before you commit.");
    expect(tokens.length).toBeGreaterThan(1);
  });

  test("a summary that names only the class (any commit) does not hold a rule about the tests before a commit", () => {
    const win = tempDir();
    const key = ledgerKey(rule("Run the tests before you commit."), REPO);
    recordPacket(win, { keys: [key], tokens: 10 }, { off: 100, att: "p1", ht: 1 });
    startEpoch(win, "compact", 500);
    expect(holdSummarized(win, "Claude committed the README typo fix and pushed it.", 600).held).toEqual([]);
  });
});

describe("probe: a fork's tokens_epoch", () => {
  // A snapshot keeps the epoch's tokens as one sum, so the copy cannot tell the packets after the fork point apart:
  // the fork's budget starts at the parent's whole epoch, an upper bound (the cap's conservative side, A4 §4).
  test("the fork's budget starts at the parent's epoch tokens, the packets after the fork point included", () => {
    const parent = tempDir();
    const fork = tempDir();
    recordPacket(
      parent,
      { keys: [ledgerKey(rule("Never push to main"), REPO)], tokens: 10 },
      { off: 1, att: "p1", ht: 1 },
    );
    recordPacket(
      parent,
      { keys: [ledgerKey(rule("Never deploy on Friday"), REPO)], tokens: 500 },
      { off: 2, att: "p2", ht: 2 },
    );
    expect(inheritLedger(parent, fork, new Set(["p2"]))).toBe(1);
    expect(readLedger(fork).tokensEpoch).toBe(510);
  });
});
