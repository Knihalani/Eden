/**
 * P1.2's epochs (A4 §4 "Re-arm", D25): value tokens, PostCompact's hold of what `compact_summary` still names, and a
 * fork's copy of its parent's ledger.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDelta } from "./memory-delta";
import { inheritFork, markFork } from "./memory-fork";
import {
  foldLedger,
  holdSummarized,
  inheritLedger,
  ledgerKey,
  liveDeliveries,
  readLedger,
  recordPacket,
  REFRACTORY_BYTES,
  startEpoch,
} from "./memory-ledger";
import { ruleValueTokens, slotValueTokens, summaryTokens } from "./memory-value-tokens";
import { forkMark, LIVE_LEDGER, SHADOW_LEDGER, windowDir } from "./memory-window";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-epochs-"));
  dirs.push(dir);
  return dir;
}

const REPO = "a1b2c3d4e5f60718";
const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}`, kind: "fact" });
const rule = (text: string) => ({ id: text, text, kind: "constraint" });
const episode = (text: string) => ({ id: text, text, kind: "episode" });
const POSTGRES = fact("The database is postgres");
const NO_MERGE = rule("Don't merge PRs yourself.");
const CLERK = episode("We switched auth to Clerk last week");

function deliver(
  win: string,
  notes: { text: string }[],
  at: { off: number; att: string; ht?: number },
  file?: "shadow",
) {
  const keys = notes.map((note) => ledgerKey(note, REPO));
  recordPacket(win, { keys, tokens: 10 }, { ht: 1, ...at }, file ? SHADOW_LEDGER : LIVE_LEDGER);
}

const cidOf = (note: { text: string }) => ledgerKey(note, REPO).cid;
const live = (win: string, size: number) => liveDeliveries(win, size).map((delivery) => delivery.cid);

describe("A4 §4: value tokens", () => {
  test("a slot's are its value's words; a rule's its class verb and object; other kinds have none", () => {
    expect(slotValueTokens("postgres")).toEqual(["postgres"]);
    expect(slotValueTokens("node 22")).toEqual(["node", "22"]);
    expect(ruleValueTokens("Don't merge PRs yourself.")).toEqual(["@integrate", "pr"]);
    expect(ruleValueTokens("Never push to the main branch")).toEqual(["@push-upstream", "main", "branch"]);
    expect(ruleValueTokens("Always run the tests with vitest")).toEqual(["run", "test", "vitest"]);
    expect(ledgerKey(CLERK, REPO).vt).toBeUndefined();
    expect(ledgerKey(POSTGRES, REPO).vt).toHaveLength(1);
  });

  test("a summary names a class by any of its verbs, inflected, and an object in either number", () => {
    const named = summaryTokens("The user asked Claude not to be merging pull requests or PRs; deploys were landed.");
    expect(named.has("@integrate")).toBe(true);
    expect(named.has("pr")).toBe(true);
    expect(named.has("@deploy")).toBe(true);
    expect(summaryTokens("Committed the fix.").has("@commit")).toBe(true);
    expect(summaryTokens("The merger was approved.").has("@integrate")).toBe(false);
  });
});

describe("A4 §4: PostCompact holds what the summary still names", () => {
  test("only deliveries of the closed epoch whose tokens the summary names in full; an episode never", () => {
    const win = tempDir();
    deliver(win, [POSTGRES, NO_MERGE, CLERK], { off: 100, att: "p1" });
    startEpoch(win, "compact", 500);
    const kept = holdSummarized(win, "The database is postgres. We switched auth to Clerk last week.", 600);
    expect(kept).toEqual({ held: [cidOf(POSTGRES)], rearmed: 2 });
    expect(live(win, 700)).toEqual([cidOf(POSTGRES)]);
  });

  test("a rule is held by its class and object, not by its verb alone", () => {
    const win = tempDir();
    deliver(win, [NO_MERGE], { off: 100, att: "p1" });
    startEpoch(win, "compact", 500);
    expect(holdSummarized(win, "We merged the fix into the release branch.", 600).held).toEqual([]);
    startEpoch(win, "compact", 700);
    deliver(win, [NO_MERGE], { off: 750, att: "p2" });
    startEpoch(win, "compact", 800);
    expect(holdSummarized(win, "The user wants no PRs merged by the agent.", 900).held).toEqual([cidOf(NO_MERGE)]);
  });

  test("a held delivery counts its distance from the summary, and is on every branch", () => {
    const win = tempDir();
    deliver(win, [POSTGRES], { off: 100, att: "p-old" });
    startEpoch(win, "compact", 1_000_000);
    holdSummarized(win, "postgres", 1_000_000);
    expect(live(win, 100 + REFRACTORY_BYTES.other)).toEqual([cidOf(POSTGRES)]);
    expect(live(win, 1_000_000 + REFRACTORY_BYTES.other)).toEqual([]);
    expect(readLedger(win).delivered.get(cidOf(POSTGRES))).toMatchObject({ epoch: 1, off: 1_000_000, att: "" });
  });

  test("only the epoch the compaction closed: an older one stays re-armed", () => {
    const win = tempDir();
    deliver(win, [POSTGRES], { off: 100, att: "p1" });
    startEpoch(win, "clear", 200);
    startEpoch(win, "compact", 300);
    expect(holdSummarized(win, "The database is postgres.", 300)).toEqual({ held: [], rearmed: 0 });
  });

  test("the hold survives a fold, and no record holds the summary's or a value's words (X11)", () => {
    const win = tempDir();
    deliver(win, [POSTGRES, NO_MERGE], { off: 100, att: "p1" });
    startEpoch(win, "compact", 500);
    holdSummarized(win, "The database is postgres; quokkas were discussed.", 600);
    expect(foldLedger(win, LIVE_LEDGER)).toBe(true);
    expect(live(win, 700)).toEqual([cidOf(POSTGRES)]);
    const files = readdirSync(win).map((name) => readFileSync(join(win, name), "utf8"));
    expect(files.join("\n")).not.toMatch(/postgres|quokka|merge/i);
  });

  test("the shadow ledger is held by its own epochs", () => {
    const win = tempDir();
    deliver(win, [POSTGRES], { off: 100, att: "p1" }, "shadow");
    startEpoch(win, "compact", 500, SHADOW_LEDGER);
    expect(holdSummarized(win, "postgres", 600, LIVE_LEDGER).held).toEqual([]);
    expect(holdSummarized(win, "postgres", 600, SHADOW_LEDGER).held).toEqual([cidOf(POSTGRES)]);
    expect(liveDeliveries(win, 700, SHADOW_LEDGER).map((d) => d.cid)).toEqual([cidOf(POSTGRES)]);
  });
});

describe("D25: a fork copies its parent's ledger", () => {
  test("inheritLedger: the parent's current epoch, on its branch, before the fork point, with its tokens", () => {
    const parent = tempDir();
    const fork = tempDir();
    deliver(parent, [CLERK], { off: 10, att: "p0" });
    startEpoch(parent, "compact", 50);
    deliver(parent, [POSTGRES], { off: 100, att: "p1" });
    deliver(parent, [NO_MERGE], { off: 200, att: "p2" });
    expect(inheritLedger(parent, fork, new Set(["p2"]))).toBe(1);
    const state = readLedger(fork);
    expect([...state.delivered.keys()]).toEqual([cidOf(POSTGRES)]);
    expect(state.delivered.get(cidOf(POSTGRES))).toMatchObject({ epoch: 0, off: 100, att: "p1", ht: 0 });
    expect(state.tokensEpoch).toBe(20);
  });

  describe("inheritFork: the parent is found by the fork's lines", () => {
    type Line = Record<string, unknown>;
    const typed = (uuid: string, parentUuid: string | null, promptId: string): Line => ({
      type: "user",
      uuid,
      parentUuid,
      promptId,
      message: { role: "user", content: `prompt ${promptId}` },
    });
    const said = (uuid: string, parentUuid: string): Line => ({
      type: "assistant",
      uuid,
      parentUuid,
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    });
    /** A memory root and a project folder of transcripts; `session` writes one and encodes it into its window. */
    function world() {
      const root = tempDir();
      const projects = join(tempDir(), "project");
      mkdirSync(projects, { recursive: true });
      const path = (session: string) => join(projects, `${session}.jsonl`);
      const session = (id: string, lines: Line[]) => {
        writeFileSync(path(id), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
        const win = windowDir(root, id)!;
        encodeDelta(win, path(id), () => {});
        return win;
      };
      return { root, path, session };
    }
    const PARENT_LINES = [typed("u1", null, "p1"), said("a1", "u1"), typed("u2", "a1", "p2"), said("a2", "u2")];
    const AFTER = [typed("u3", "a2", "p3"), said("a3", "u3")];
    /** A fork of the parent at `a2`: its lines with the fork's promptId, then its own turn. */
    const FORK_LINES = [
      ...PARENT_LINES.map((line) => (line.promptId ? { ...line, promptId: "f1" } : line)),
      typed("v1", "a2", "f1"),
      said("b1", "v1"),
    ];

    test("deliveries before the fork point are copied, those after it are not; the mark is resolved", () => {
      const { root, path, session } = world();
      const parent = session("parent", [...PARENT_LINES, ...AFTER]);
      deliver(parent, [POSTGRES], { off: 100, att: "p2" });
      deliver(parent, [NO_MERGE], { off: 200, att: "p3" });
      const fork = windowDir(root, "fork")!;
      markFork(fork, 1_000, 5);
      expect(forkMark(fork)).toEqual({ last: -4_000 });
      expect(inheritFork(root, fork, path("fork"))).toBeUndefined();
      session("fork", FORK_LINES);
      expect(inheritFork(root, fork, path("fork"))).toEqual({ from: "parent", copied: 1 });
      expect([...readLedger(fork).delivered.keys()]).toEqual([cidOf(POSTGRES)]);
      expect(forkMark(fork)).toEqual({ from: "parent" });
      expect(inheritFork(root, fork, path("fork"))).toBeUndefined();
    });

    test("a sibling fork of the same point loses the tie to the parent", () => {
      const { root, path, session } = world();
      const parent = session("parent", PARENT_LINES);
      deliver(parent, [POSTGRES], { off: 100, att: "p2" });
      const sibling = session("sibling", FORK_LINES);
      markFork(sibling, 1_000, undefined);
      deliver(sibling, [NO_MERGE], { off: 300, att: "f1" });
      const fork = windowDir(root, "fork")!;
      markFork(fork, 1_000, undefined);
      session("fork", [...FORK_LINES.slice(0, 4), typed("w1", "a2", "g1")]);
      expect(inheritFork(root, fork, path("fork"))).toEqual({ from: "parent", copied: 1 });
    });

    test("no window shares a line: resolved with no parent, and not looked for again", () => {
      const { root, path, session } = world();
      session("stranger", [typed("x1", null, "q1")]);
      const fork = windowDir(root, "fork")!;
      markFork(fork, 1_000, undefined);
      session("fork", FORK_LINES);
      expect(inheritFork(root, fork, path("fork"))).toEqual({ from: "", copied: 0 });
      expect(forkMark(fork)).toEqual({ from: "" });
    });

    test("a window that was never forked copies nothing", () => {
      const { root, path, session } = world();
      session("parent", PARENT_LINES);
      const win = session("fork", FORK_LINES);
      expect(inheritFork(root, win, path("fork"))).toBeUndefined();
    });
  });
});
