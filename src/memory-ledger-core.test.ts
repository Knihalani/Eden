/**
 * P1.1's ledger core (A4 §4, D25): the `delivery.json` snapshot written by rename after the log is rotated, readers
 * folding snapshot + logs, `hturn` across rotations, the overflow policy, `<repo8>/` cids, `Updated:` items and the
 * 6k-token epoch budget.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPOCH_TOKEN_CAP,
  foldLedger,
  humanTurns,
  ledgerKey,
  liveDeliveries,
  novelNotes,
  OVERFLOW_ENTRIES,
  readLedger,
  recordPacket,
  startEpoch,
  withinBudget,
} from "./memory-ledger";
import { invalidationsIn } from "./memory-validity";
import { appendTurn, LIVE_LEDGER, SHADOW_LEDGER, type LedgerFile } from "./memory-window";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ledger-core-"));
  dirs.push(dir);
  return dir;
}

const REPO = "a1b2c3d4e5f60718";
const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}`, kind: "fact" });
const rule = (text: string) => ({ id: text, text, kind: "constraint" });
const episode = (text: string) => ({ id: text, text, kind: "episode" });

/** One packet's deliveries, as the hook records them. */
function deliver(win: string, notes: { text: string }[], at: { off: number; att: string; ht: number }, tokens = 0) {
  recordPacket(win, { keys: notes.map((note) => ledgerKey(note, REPO)), tokens }, at);
}

/** What a fold yields, comparable across a snapshot. */
function folded(win: string, file: LedgerFile = LIVE_LEDGER) {
  const state = readLedger(win, file);
  return { ...state, delivered: Object.fromEntries(state.delivered) };
}

describe("A4 §4: cids carry the repo", () => {
  test("cid = <repo8>/<kind letter>:<key>, so two repos in one window never collide", () => {
    expect(ledgerKey(fact("The database is postgres"), REPO).cid).toMatch(/^a1b2c3d4\/s:/);
    expect(ledgerKey(rule("Never merge PRs yourself."), REPO).cid).toMatch(/^a1b2c3d4\/P:/);
    expect(ledgerKey(episode("We switched auth to Clerk"), REPO).cid).toMatch(/^a1b2c3d4\/E:/);
    expect(ledgerKey(episode("We switched auth to Clerk"), REPO).cid).not.toBe(
      ledgerKey(episode("We switched auth to Clerk"), "ffffffff00000000").cid,
    );
  });
});

describe("D25: the snapshot, the rotation and the fold", () => {
  function sample(win: string) {
    appendTurn(win, { promptId: "p1", prompt: "a", off: 0 });
    deliver(
      win,
      [fact("The database is postgres"), rule("Never merge PRs yourself.")],
      { off: 10, att: "p1", ht: 1 },
      40,
    );
    appendTurn(win, { promptId: "p2", prompt: "b", off: 500 });
    deliver(win, [episode("We switched auth to Clerk")], { off: 510, att: "p2", ht: 2 }, 25);
    deliver(win, [fact("The database is postgres")], { off: 900, att: "p2", ht: 2 }, 15);
  }

  test("a fold writes delivery.json by rename and rotates the log away; readers see the same ledger", () => {
    const win = tempDir();
    sample(win);
    const before = folded(win);
    expect(before.delivered[ledgerKey(fact("The database is postgres"), REPO).cid]).toMatchObject({ off: 900, n: 2 });
    expect(before).toMatchObject({ epoch: 0, tokensEpoch: 80, turns: 2 });
    expect(foldLedger(win, LIVE_LEDGER)).toBe(true);
    expect(existsSync(join(win, "delivery.json"))).toBe(true);
    expect(existsSync(join(win, "delivery.log")) ? readFileSync(join(win, "delivery.log"), "utf8") : "").toBe("");
    expect(readdirSync(win).filter((name) => name.startsWith("delivery.log."))).toEqual([]);
    expect(folded(win)).toEqual(before);
    const snapshot = JSON.parse(readFileSync(join(win, "delivery.json"), "utf8"));
    expect(snapshot).toMatchObject({ v: 2, epoch: 0, tokens_epoch: 80 });
  });

  test("records appended after a fold are folded on top of the snapshot; a second fold keeps them", () => {
    const win = tempDir();
    sample(win);
    foldLedger(win, LIVE_LEDGER);
    startEpoch(win, "compact", 1_000);
    deliver(win, [rule("Never merge PRs yourself.")], { off: 1_100, att: "p3", ht: 3 }, 30);
    const after = folded(win);
    expect(after).toMatchObject({ epoch: 1, tokensEpoch: 30 });
    foldLedger(win, LIVE_LEDGER);
    expect(folded(win)).toEqual(after);
  });

  test("a rotated log left by a fold that stopped before removing it is not folded twice", () => {
    const win = tempDir();
    sample(win);
    const before = folded(win);
    const log = readFileSync(join(win, "delivery.log"));
    foldLedger(win, LIVE_LEDGER);
    const { through } = JSON.parse(readFileSync(join(win, "delivery.json"), "utf8")) as { through: string };
    writeFileSync(join(win, `delivery.log.${through}`), log);
    expect(folded(win)).toEqual(before);
    foldLedger(win, LIVE_LEDGER);
    expect(folded(win)).toEqual(before);
  });

  test("a rotated log a fold never took (it stopped after the rename) is read, then folded", () => {
    const win = tempDir();
    sample(win);
    const before = folded(win);
    const log = readFileSync(join(win, "delivery.log"));
    rmSync(join(win, "delivery.log"));
    writeFileSync(join(win, "delivery.log.00000000000000000000000001"), log);
    expect(folded(win)).toEqual(before);
    foldLedger(win, LIVE_LEDGER);
    expect(folded(win)).toEqual(before);
  });

  test("the shadow ledger folds into its own snapshot", () => {
    const win = tempDir();
    recordPacket(
      win,
      { keys: [ledgerKey(fact("The database is postgres"), REPO)], tokens: 12 },
      { off: 0, att: "p1", ht: 1 },
      SHADOW_LEDGER,
    );
    const before = folded(win, SHADOW_LEDGER);
    foldLedger(win, SHADOW_LEDGER);
    expect(existsSync(join(win, "delivery.shadow.json"))).toBe(true);
    expect(folded(win, SHADOW_LEDGER)).toEqual(before);
    expect(readLedger(win, LIVE_LEDGER).delivered.size).toBe(0);
  });

  test("a torn snapshot reads as none: the logs still fold", () => {
    const win = tempDir();
    sample(win);
    writeFileSync(join(win, "delivery.json"), '{"v":2,"epo');
    expect(folded(win).turns).toBe(2);
  });
});

describe("A4 §4: hturn across rotations", () => {
  test("turns folded into the snapshot still count, and a repeated prompt_id after the fold counts once", () => {
    const win = tempDir();
    for (const id of ["p1", "p2", "p3"]) appendTurn(win, { promptId: id, prompt: id, off: 0 });
    foldLedger(win, LIVE_LEDGER);
    expect(humanTurns(win)).toBe(3);
    appendTurn(win, { promptId: "p3", prompt: "p3", off: 0 });
    appendTurn(win, { promptId: "p4", prompt: "p4", off: 9 });
    expect(humanTurns(win)).toBe(4);
    foldLedger(win, LIVE_LEDGER);
    expect(humanTurns(win)).toBe(4);
  });

  test("turns count from both ledgers", () => {
    const win = tempDir();
    appendTurn(win, { promptId: "p1", prompt: "a", off: 0 });
    appendTurn(win, { promptId: "p2", prompt: "b", off: 0 }, SHADOW_LEDGER);
    foldLedger(win, SHADOW_LEDGER);
    expect(humanTurns(win)).toBe(2);
  });
});

describe("D25: overflow above 256 entries", () => {
  test("older epochs go first", () => {
    const win = tempDir();
    for (let n = 0; n < 60; n++) deliver(win, [episode(`old note ${n + 100} alpha`)], { off: n, att: "p1", ht: 1 });
    startEpoch(win, "compact", 100);
    for (let n = 0; n < 210; n++)
      deliver(win, [episode(`new note ${n + 100} beta`)], { off: 200 + n, att: "p2", ht: 2 });
    foldLedger(win, LIVE_LEDGER);
    const state = readLedger(win, LIVE_LEDGER);
    expect(state.delivered.size).toBe(OVERFLOW_ENTRIES);
    expect([...state.delivered.values()].filter((entry) => entry.epoch === 0)).toHaveLength(OVERFLOW_ENTRIES - 210);
    expect(state.delivered.has(ledgerKey(episode("old note 159 alpha"), REPO).cid)).toBe(true);
    expect(state.delivered.has(ledgerKey(episode("old note 100 alpha"), REPO).cid)).toBe(false);
  });

  test("then the least recent episodes; rules and slots stay", () => {
    const win = tempDir();
    for (let n = 0; n < 20; n++)
      deliver(win, [rule(`Never touch module ${n + 100} gamma`)], { off: n, att: "p1", ht: 1 });
    for (let n = 0; n < 250; n++) deliver(win, [episode(`note ${n + 100} delta`)], { off: 100 + n, att: "p1", ht: 1 });
    foldLedger(win, LIVE_LEDGER);
    const state = readLedger(win, LIVE_LEDGER);
    expect(state.delivered.size).toBe(OVERFLOW_ENTRIES);
    expect([...state.delivered.keys()].filter((cid) => cid.includes("/P:"))).toHaveLength(20);
    expect(state.delivered.has(ledgerKey(episode("note 100 delta"), REPO).cid)).toBe(false);
    expect(state.delivered.has(ledgerKey(episode("note 349 delta"), REPO).cid)).toBe(true);
  });
});

describe("A4 §4: refractory and Updated items, against the live deliveries", () => {
  /** P0.3's log of a supersession ("The database is postgres" after "… sqlite"), and D7's switch. */
  const superseded = [{ k: "retract" as const, o: "sqlite", t: 1, w: ["database"] }];
  const switched = invalidationsIn("We switched auth from Auth0 to Clerk.", 2);

  test("a live delivery keeps its cid from coming back at the same ver; at another ver it comes back as Updated", () => {
    const win = tempDir();
    deliver(win, [fact("The database is sqlite")], { off: 0, att: "p1", ht: 1 });
    const live = liveDeliveries(win, 100);
    expect(novelNotes([fact("The database is sqlite")], live, { repo: REPO })).toEqual([]);
    const [updated] = novelNotes([fact("The database is postgres")], live, { repo: REPO, invalid: superseded });
    expect(updated).toMatchObject({ id: "The database is postgres", update: { was: "sqlite" } });
    const [unknown] = novelNotes([fact("The database is postgres")], live, { repo: REPO });
    expect(unknown?.update).toEqual({});
  });

  test("a row stating a switch away from a delivered value is its Updated item", () => {
    const win = tempDir();
    deliver(win, [fact("Our auth provider is Auth0")], { off: 0, att: "p1", ht: 1 });
    const live = liveDeliveries(win, 100);
    const [updated] = novelNotes([episode("We switched auth from Auth0 to Clerk")], live, {
      repo: REPO,
      invalid: switched,
    });
    expect(updated).toMatchObject({ update: { was: "Auth0" } });
    const [plain] = novelNotes([episode("We switched the queue from Kafka to SQS")], live, {
      repo: REPO,
      invalid: switched,
    });
    expect(plain?.update).toBeUndefined();
  });

  test("one Updated item per changed delivery: a second row stating the same switch is not delivered (P1.1 e2e)", () => {
    const win = tempDir();
    deliver(win, [fact("Our auth provider is Auth0")], { off: 0, att: "p1", ht: 1 });
    const rows = [
      episode("We switched auth from Auth0 to Clerk. Reply with just OK."),
      episode("We switched auth from Auth0 to Clerk"),
    ];
    const novel = novelNotes(rows, liveDeliveries(win, 100), { repo: REPO, invalid: switched });
    expect(novel.map((note) => note.id)).toEqual([rows[0]!.id]);
    expect(novel[0]?.update).toMatchObject({ was: "Auth0" });
  });

  test("the ledger holds no text: the old value comes from the invalidation log", () => {
    const win = tempDir();
    deliver(win, [fact("Our auth provider is Auth0")], { off: 0, att: "p1", ht: 1 });
    expect(readFileSync(join(win, "delivery.log"), "utf8")).not.toMatch(/auth0/i);
  });

  test("a delivery out of the window, or of an earlier epoch, is no longer live: plain bullets again", () => {
    const win = tempDir();
    deliver(win, [fact("The database is sqlite")], { off: 0, att: "p1", ht: 1 });
    const far = novelNotes([fact("The database is postgres")], liveDeliveries(win, 1_300_000), {
      repo: REPO,
      invalid: superseded,
    });
    expect(far[0]?.update).toBeUndefined();
    startEpoch(win, "compact", 50);
    expect(novelNotes([fact("The database is sqlite")], liveDeliveries(win, 100), { repo: REPO })).toHaveLength(1);
  });

  test("a shadow point's live deliveries are both ledgers'", () => {
    const win = tempDir();
    recordPacket(
      win,
      { keys: [ledgerKey(fact("The database is sqlite"), REPO)], tokens: 0 },
      { off: 0, att: "p1", ht: 1 },
      SHADOW_LEDGER,
    );
    const sqlite = [fact("The database is sqlite")];
    expect(novelNotes(sqlite, liveDeliveries(win, 10), { repo: REPO })).toHaveLength(1);
    expect(novelNotes(sqlite, liveDeliveries(win, 10, SHADOW_LEDGER), { repo: REPO })).toEqual([]);
  });
});

describe("A4 §4: the 6k-token epoch budget", () => {
  test("past 6k tokens in the epoch only Updated items pass; a new epoch resets it", () => {
    const win = tempDir();
    deliver(win, [episode("a long note epsilon")], { off: 0, att: "p1", ht: 1 }, EPOCH_TOKEN_CAP);
    const notes = [
      { ...episode("another note zeta") },
      { ...fact("The database is postgres"), update: { was: "sqlite" } },
    ];
    expect(withinBudget(notes, readLedger(win).tokensEpoch).map((note) => note.id)).toEqual([
      "The database is postgres",
    ]);
    startEpoch(win, "compact", 10);
    expect(withinBudget(notes, readLedger(win).tokensEpoch)).toHaveLength(2);
  });
});
