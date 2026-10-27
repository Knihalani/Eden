/**
 * P3.4's `Updated:` items outside a human Submit (A4 §5.2, D24): a live keyed row whose `(scope, slot)` the window
 * holds at another value, read through validity first. A typed row stating two slots, one since ended by a mined
 * change, states no change (P3.4's world-1 replay: it and the mined row took turns as `Updated:` items on every
 * non-human Submit).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord } from "./index";
import { deliveredKeys } from "./memory-ledger";
import { updatedItems } from "./memory-updates";
import { readInvalidations, recordSlotChanges } from "./memory-validity";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const REPO = "0123456789abcdef";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const typedRow: MemoryRecord = {
  id: "a",
  text: "In apps/web the auth provider is Auth0, and the database is postgres",
  kind: "fact",
  tags: ["src:user"],
  at: T0,
  scope: "apps/web",
  slots: [
    { k: "auth.provider", v: "auth0" },
    { k: "db.engine", v: "postgres" },
  ],
};
const minedRow: MemoryRecord = {
  id: "b",
  text: "In apps/web the auth provider is clerk",
  kind: "fact",
  tags: ["src:tool"],
  at: T0 + 60_000,
  scope: "apps/web",
  slots: [{ k: "auth.provider", v: "clerk" }],
  cite: ["apps/web/package.json"],
};

/** The store's invalidations after the mined clerk ended Auth0 at apps/web. */
function auth0Ended() {
  const dir = mkdtempSync(join(tmpdir(), "eden-updates-"));
  dirs.push(dir);
  recordSlotChanges(dir, [{ slot: "auth.provider", value: "auth0", typed: "Auth0", scope: "apps/web" }], T0 + 60_000);
  return readInvalidations(dir);
}

const auth = (row: MemoryRecord) =>
  deliveredKeys(row, REPO)
    .filter((key) => key.cid.endsWith("auth.provider"))
    .map(({ cid, ver }) => ({ cid, ver }));

describe("updatedItems", () => {
  test("a window given Auth0 is told the mined clerk, once; the cut typed row is no item", () => {
    const invalid = auth0Ended();
    const items = updatedItems([typedRow, minedRow], auth(typedRow), { repo: REPO, invalid });
    expect(items.map((item) => [item.id, item.update?.was])).toEqual([["b", "Auth0"]]);
  });

  test("a window given clerk gets nothing: the typed row's Auth0 is ended, so it is no change back", () => {
    const invalid = auth0Ended();
    expect(updatedItems([typedRow, minedRow], auth(minedRow), { repo: REPO, invalid })).toEqual([]);
  });

  test("a value the window holds at the same ver, or never held, is no item", () => {
    expect(updatedItems([minedRow], auth(minedRow), { repo: REPO })).toEqual([]);
    expect(updatedItems([minedRow], [], { repo: REPO })).toEqual([]);
  });
});
