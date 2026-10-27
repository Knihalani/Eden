/**
 * P1.1 review round 1 probes (place in src/): the fold keeps max(`off`) (A4 §4), and an `Updated:` item for a switch
 * is given once while the window still holds it, not again through a second row a later cue retrieves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveredKeys, ledgerKey, liveDeliveries, novelNotes, readLedger, recordPacket } from "./memory-ledger";
import { invalidationsIn } from "./memory-validity";
import { appendRecords, LIVE_LEDGER } from "./memory-window";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ledger-review-"));
  dirs.push(dir);
  return dir;
}

const REPO = "a1b2c3d4e5f60718";
const fact = (text: string) => ({ id: text, text: `[fact · 0m] ${text}`, kind: "fact" });
const episode = (text: string) => ({ id: text, text, kind: "episode" });

describe("P1.1 review: the fold is a union keeping max(off) (A4 §4)", () => {
  test("a delivery line that reaches the live log late (moved back from a rotated log) does not lower off", () => {
    const win = tempDir();
    const cid = ledgerKey(fact("The database is postgres"), REPO).cid;
    const ver = ledgerKey(fact("The database is postgres"), REPO).ver;
    // The order a fold leaves when a writer's line landed in the rotated log after the fold read it: the newer
    // delivery (off 900) is already in the live log, and the late line (off 100) is appended after it.
    appendRecords(win, LIVE_LEDGER, [
      { k: "deliver", cid, ver, off: 900, att: "p2", ht: 2 },
      { k: "deliver", cid, ver, off: 100, att: "p1", ht: 1 },
    ]);
    expect(readLedger(win).delivered.get(cid)?.off).toBe(900);
  });
});

describe("P1.1 review: one Updated item per changed delivery, across turns", () => {
  test("a second row stating the same switch, retrieved a turn later, is not a second Updated item", () => {
    const win = tempDir();
    const switched = invalidationsIn("We switched auth from Auth0 to Clerk.", 2);
    recordPacket(
      win,
      { keys: [ledgerKey(fact("Our auth provider is Auth0"), REPO)], tokens: 0 },
      {
        off: 0,
        att: "p1",
        ht: 1,
      },
    );
    const sentence = episode("We switched auth from Auth0 to Clerk");
    const whole = episode("We switched auth from Auth0 to Clerk. Keep the old tenant until Friday.");
    const [first] = novelNotes([sentence], liveDeliveries(win, 100), { repo: REPO, invalid: switched });
    expect(first?.update).toMatchObject({ was: "Auth0" });
    // What the hook records for the delivered item: its own key and the slot entry it renews.
    recordPacket(win, { keys: deliveredKeys(first!, REPO), tokens: 0 }, { off: 200, att: "p2", ht: 2 });
    const later = novelNotes([sentence, whole], liveDeliveries(win, 300), { repo: REPO, invalid: switched });
    expect(later.filter((note) => note.update)).toEqual([]);
  });
});

describe("P1.1 review: a switch is an Updated item only for the slot it switches", () => {
  test("a switch away from the same value on another subject is a plain bullet, and is not dropped", () => {
    const win = tempDir();
    recordPacket(
      win,
      { keys: [ledgerKey(fact("Our CI provider is GitHub"), REPO)], tokens: 0 },
      {
        off: 0,
        att: "p1",
        ht: 1,
      },
    );
    const docs = episode("We migrated the docs site from GitHub to GitLab");
    const cache = episode("We moved the build cache from GitHub to S3");
    const timeout = episode("We moved the request timeout from 3000 to 5000 ms");
    const novel = novelNotes([docs, cache, timeout], liveDeliveries(win, 100), { repo: REPO });
    // Both rows are new information about other subjects: neither replaces what the window was told about CI.
    expect(novel.map((note) => note.id)).toEqual([docs.id, cache.id, timeout.id]);
    expect(novel.filter((note) => note.update)).toEqual([]);
  });
});
