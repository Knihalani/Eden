/**
 * P3.3 at delivery (A4 §2, §4; D25, D26): the ledger keys a slot by `(scope, slot)`, so a changed value is an
 * `Updated:` item by key comparison; D26's residual reads a slot by its aliases and value class; the two-scope bullet
 * takes the other scope's keyed value.
 */
import { describe, expect, test } from "bun:test";
import { deliveredKeys, ledgerKey, novelNotes } from "./memory-ledger";
import { twoScopeNotes } from "./memory-place";
import type { ProvenanceNote } from "./memory-provenance";
import { residualSentences, unsaidText } from "./memory-residual";

const REPO = "a1b2c3d4e5f60718";
const fact = (text: string, slots: ProvenanceNote["slots"], scope?: string): ProvenanceNote => ({
  text,
  kind: "fact",
  tags: ["src:user"],
  slots,
  ...(scope === undefined ? {} : { scope }),
});

describe("the ledger keys a slot by (scope, slot) (A4 §4)", () => {
  test("cid `s:<scope>|<slot>` (the root's `s:<slot>`), ver by the value: two phrasings of one value share both", () => {
    const one = ledgerKey(fact("We use PostgreSQL for the db.", [{ k: "db.engine", v: "postgres" }], ""), REPO);
    const two = ledgerKey(fact("The database is postgres.", [{ k: "db.engine", v: "postgres" }], ""), REPO);
    expect(one.cid).toBe("a1b2c3d4/s:db.engine");
    expect([two.cid, two.ver]).toEqual([one.cid, one.ver]);
    const cli = ledgerKey(fact("packages/cli uses sqlite.", [{ k: "db.engine", v: "sqlite" }], "packages/cli"), REPO);
    expect(cli.cid).toBe("a1b2c3d4/s:packages/cli|db.engine");
    expect(cli.ver).not.toBe(one.ver);
  });

  test("a changed value is an `Updated:` item by key, naming the value it replaces from the row's keys", () => {
    const auth0 = ledgerKey(fact("Our auth provider is Auth0.", [{ k: "auth.provider", v: "auth0" }], ""), REPO);
    const live = [{ cid: auth0.cid, ver: auth0.ver }];
    const clerk = fact("We switched auth from Auth0 to Clerk.", [{ k: "auth.provider", v: "clerk", x: ["auth0"] }], "");
    const [item] = novelNotes([clerk], live, { repo: REPO });
    expect(item?.update).toEqual({ was: "Auth0" });
    const same = fact("The auth provider is Auth0.", [{ k: "auth.provider", v: "auth0" }], "");
    expect(novelNotes([same], live, { repo: REPO })).toEqual([]);
  });

  test("a retraction of a live value is an `Updated:` item; a retraction of another value is not", () => {
    const yarn = ledgerKey(fact("We use yarn.", [{ k: "pkg.manager", v: "yarn" }], ""), REPO);
    const live = [{ cid: yarn.cid, ver: yarn.ver }];
    const gone = fact("We don't use yarn anymore.", [{ k: "pkg.manager", x: ["yarn"] }], "");
    expect(novelNotes([gone], live, { repo: REPO })[0]?.update).toEqual({ was: "yarn" });
    const other = fact("We don't use npm anymore.", [{ k: "pkg.manager", x: ["npm"] }], "");
    expect(novelNotes([other], live, { repo: REPO })[0]?.update).toBeUndefined();
  });

  test("a row stating two slots records both keys", () => {
    const note = fact("The orm is drizzle and the database is postgres.", [
      { k: "orm", v: "drizzle" },
      { k: "db.engine", v: "postgres" },
    ]);
    expect(deliveredKeys(note, REPO).map((key) => key.cid)).toEqual(["a1b2c3d4/s:orm", "a1b2c3d4/s:db.engine"]);
  });
});

describe("D26's slot rule on keys: a subject alias and the value, or the value's own `use`", () => {
  const db = fact("packages/cli uses sqlite for its database.", [{ k: "db.engine", v: "sqlite" }], "packages/cli");

  test("an alias of the slot and the value in one sentence state it, in any phrasing", () => {
    expect(unsaidText(db, residualSentences(["the db is sqlite, set up the tables"]))).toBe("");
    const pg = fact("We use PostgreSQL for the database.", [{ k: "db.engine", v: "postgres" }]);
    expect(unsaidText(pg, residualSentences(["our database is postgres"]))).toBe("");
  });

  test("a value in exactly one slot's class states it by `use` alone; a question or a negation states nothing", () => {
    const pnpm = fact("The package manager is pnpm.", [{ k: "pkg.manager", v: "pnpm" }]);
    expect(unsaidText(pnpm, residualSentences(["use pnpm to install it"]))).toBe("");
    expect(unsaidText(db, residualSentences(["is the db sqlite?"]))).toBe(db.text);
    expect(unsaidText(db, residualSentences(["we don't use sqlite for the db anymore"]))).toBe(db.text);
  });
});

describe("the two-scope bullet takes the other scope's keyed value (A4 §2, D4)", () => {
  test("one bullet with each scope's value of the slot, named by the slot's label", () => {
    const web = { id: "w", ...fact("In apps/web the database is postgres.", [{ k: "db.engine", v: "postgres" }]) };
    const cli = { id: "c", ...fact("packages/cli uses sqlite for its database.", [{ k: "db.engine", v: "sqlite" }]) };
    const notes = twoScopeNotes(
      [{ ...web, scope: "apps/web" }],
      ["apps/web", "packages/cli"],
      (scope) => (scope === "packages/cli" ? [{ ...cli, scope }] : []),
    );
    expect(notes.map((note) => note.text)).toEqual(["database — apps/web: postgres · packages/cli: sqlite"]);
  });
});
