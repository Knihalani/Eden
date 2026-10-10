import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ledgerKey,
  liveDeliveries,
  novelNotes,
  recordPacket,
  REFRACTORY_BYTES,
  startEpoch,
  wouldPreempt,
  type Moment,
} from "./memory-ledger";
import { encodeDelta } from "./memory-delta";
import type { ProvenanceNote } from "./memory-provenance";
import { SHADOW_LEDGER, type LedgerFile } from "./memory-window";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ledger-"));
  dirs.push(dir);
  return dir;
}

/** P0.2's calls on P1.1's API: one packet's deliveries, and the notes still eligible against the live ones. */
function recordDeliveries(win: string, notes: readonly ProvenanceNote[], at: Moment, file?: LedgerFile): void {
  recordPacket(win, { keys: notes.map((note) => ledgerKey(note)), tokens: 0 }, at, file);
}
function notRefractory<T extends ProvenanceNote>(win: string, notes: readonly T[], size: number, file?: LedgerFile) {
  return novelNotes(notes, liveDeliveries(win, size, file));
}

const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}` });
const rule = (text: string) => ({ id: text, text, kind: "constraint" });
const episode = (text: string) => ({ id: text, text, kind: "episode" });

describe("A4 §4: cid and ver", () => {
  test("a fact is keyed by its subject; its value is the ver", () => {
    expect(ledgerKey(fact("The database is postgres")).cid).toBe(ledgerKey(fact("the database is sqlite.")).cid);
    expect(ledgerKey(fact("The database is postgres")).ver).not.toBe(ledgerKey(fact("the database is sqlite")).ver);
    expect(ledgerKey(fact("The database is postgres"))).toEqual(ledgerKey(fact("the database is Postgres.")));
  });

  test("rules and episodes are keyed by their content words, so near-identical text shares a cid", () => {
    expect(ledgerKey(rule("Never merge PRs yourself."))).toMatchObject({ rule: true });
    expect(ledgerKey(rule("Never merge PRs yourself.")).cid).toMatch(/^P:/);
    expect(ledgerKey(episode("We switched auth to Clerk")).cid).toMatch(/^E:/);
    expect(ledgerKey(episode("We switched auth to Clerk")).cid).toBe(
      ledgerKey(episode("we switched AUTH to clerk!")).cid,
    );
    expect(ledgerKey(episode("We switched auth to Clerk")).cid).not.toBe(ledgerKey(episode("We switched db")).cid);
  });
});

describe("A4 §4: the refractory rule", () => {
  test("a delivered bullet waits 400 KB (rules) or 1.2 MB (others) of transcript", () => {
    const win = tempDir();
    const notes = [rule("Never merge PRs yourself."), episode("We switched auth to Clerk")];
    recordDeliveries(win, notes, { off: 1_000, att: "p1", ht: 1 });
    const left = (size: number) => notRefractory(win, notes, size).map((n) => n.id);
    expect(left(1_000)).toEqual([]);
    expect(left(1_000 + REFRACTORY_BYTES.rule - 1)).toEqual([]);
    expect(left(1_000 + REFRACTORY_BYTES.rule)).toEqual(["Never merge PRs yourself."]);
    expect(left(1_000 + REFRACTORY_BYTES.other)).toEqual(notes.map((n) => n.id));
  });

  test("a new value, or a new epoch, re-arms", () => {
    const win = tempDir();
    recordDeliveries(win, [fact("The database is postgres")], { off: 0, att: "p1", ht: 1 });
    const now = 10;
    expect(notRefractory(win, [fact("The database is postgres")], now)).toEqual([]);
    expect(notRefractory(win, [fact("The database is sqlite")], now)).toHaveLength(1);
    startEpoch(win, "compact", 5);
    expect(notRefractory(win, [fact("The database is postgres")], now)).toHaveLength(1);
    expect(readFileSync(join(win, "delivery.log"), "utf8")).not.toContain("postgres");
  });

  test("a delivery on a branch the delta encoder found abandoned does not count; an unread prompt does", () => {
    const win = tempDir();
    const path = join(tempDir(), "t.jsonl");
    const line = (uuid: string, parentUuid: string | null, promptId: string) =>
      JSON.stringify({ type: "user", uuid, parentUuid, promptId, message: { role: "user", content: promptId } });
    // p1 → p2 (abandoned) ; p1 → p3 (the current branch)
    writeFileSync(path, [line("u1", null, "p1"), line("u2", "u1", "p2"), line("u3", "u1", "p3")].join("\n") + "\n");
    encodeDelta(win, path, () => {});
    const clerk = episode("We switched auth to Clerk");
    const now = 100;
    recordDeliveries(win, [clerk], { off: 50, att: "p2", ht: 2 });
    expect(notRefractory(win, [clerk], now)).toHaveLength(1);
    recordDeliveries(win, [clerk], { off: 60, att: "p4", ht: 3 });
    expect(notRefractory(win, [clerk], now)).toHaveLength(0);
  });
});

describe("X7: the shadow ledger", () => {
  test("a shadow point's refractory rule reads both ledgers, each folded by its own epochs; a live one reads its own", () => {
    const win = tempDir();
    const now = 100;
    const pg = fact("The database is postgres");
    recordDeliveries(win, [pg], { off: 0, att: "p1", ht: 1 }, SHADOW_LEDGER);
    expect(notRefractory(win, [pg], now)).toHaveLength(1);
    expect(notRefractory(win, [pg], now, SHADOW_LEDGER)).toHaveLength(0);
    startEpoch(win, "compact", 10, SHADOW_LEDGER);
    expect(notRefractory(win, [pg], now, SHADOW_LEDGER)).toHaveLength(1);
    recordDeliveries(win, [pg], { off: 20, att: "p2", ht: 2 });
    expect(notRefractory(win, [pg], now, SHADOW_LEDGER)).toHaveLength(0);
  });

  test("would_preempt: a statement of a shadow delivery from the last 3 human turns; a slot only at its value", () => {
    const win = tempDir();
    const merge = rule("Never merge PRs yourself.");
    recordDeliveries(win, [merge, fact("The database is postgres")], { off: 0, att: "p1", ht: 1 }, SHADOW_LEDGER);
    const ruleCid = ledgerKey(merge).cid;
    const slotCid = ledgerKey(fact("The database is postgres")).cid;
    expect(wouldPreempt(win, ["never merge PRs yourself"], 2)).toEqual([ruleCid]);
    expect(wouldPreempt(win, ["The database is postgres."], 4)).toEqual([slotCid]);
    expect(wouldPreempt(win, ["The database is sqlite."], 2)).toEqual([]);
    expect(wouldPreempt(win, ["never merge PRs yourself"], 5)).toEqual([]);
    expect(wouldPreempt(win, ["never merge PRs yourself"], 1)).toEqual([]);
    recordDeliveries(win, [merge], { off: 0, att: "p9", ht: 1 });
    expect(wouldPreempt(tempDir(), ["never merge PRs yourself"], 2)).toEqual([]);
  });
});
