import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerKey, notRefractory, recordDeliveries, REFRACTORY_BYTES, startEpoch } from "./memory-ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-ledger-"));
  dirs.push(dir);
  return dir;
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
    const left = (size: number) => notRefractory(win, notes, { size, transcriptPath: "" }).map((n) => n.id);
    expect(left(1_000)).toEqual([]);
    expect(left(1_000 + REFRACTORY_BYTES.rule - 1)).toEqual([]);
    expect(left(1_000 + REFRACTORY_BYTES.rule)).toEqual(["Never merge PRs yourself."]);
    expect(left(1_000 + REFRACTORY_BYTES.other)).toEqual(notes.map((n) => n.id));
  });

  test("a new value, or a new epoch, re-arms", () => {
    const win = tempDir();
    recordDeliveries(win, [fact("The database is postgres")], { off: 0, att: "p1", ht: 1 });
    const now = { size: 10, transcriptPath: "" };
    expect(notRefractory(win, [fact("The database is postgres")], now)).toEqual([]);
    expect(notRefractory(win, [fact("The database is sqlite")], now)).toHaveLength(1);
    startEpoch(win, "compact", 5);
    expect(notRefractory(win, [fact("The database is postgres")], now)).toHaveLength(1);
    expect(readFileSync(join(win, "delivery.log"), "utf8")).not.toContain("postgres");
  });

  test("a delivery on an abandoned branch (a rewind) does not count; an unwritten prompt does", () => {
    const win = tempDir();
    const path = join(tempDir(), "t.jsonl");
    const line = (uuid: string, parentUuid: string | null, promptId: string) =>
      JSON.stringify({ type: "user", uuid, parentUuid, promptId, message: { role: "user", content: promptId } });
    // p1 → p2 (abandoned) ; p1 → p3 (the current branch)
    writeFileSync(path, [line("u1", null, "p1"), line("u2", "u1", "p2"), line("u3", "u1", "p3")].join("\n") + "\n");
    const clerk = episode("We switched auth to Clerk");
    const now = { size: 100, transcriptPath: path };
    recordDeliveries(win, [clerk], { off: 50, att: "p2", ht: 2 });
    expect(notRefractory(win, [clerk], now)).toHaveLength(1);
    recordDeliveries(win, [clerk], { off: 60, att: "p4", ht: 3 });
    expect(notRefractory(win, [clerk], now)).toHaveLength(0);
  });
});
