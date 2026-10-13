/**
 * P3.3 in the store (D6, D7, A4 §3.1–3.2, D31): a typed slot statement is a keyed row; a value supersedes by key at
 * its own scope; `use A not B` and a retraction invalidate, a retraction with no successor; an equal value writes no
 * row; a root slot is written at `""`; and older text giving a superseded value is stale at that scope and below.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubTombstonedIdentity } from "./gist-store";
import { openMemory, superseded, type MemoryRecord } from "./index";
import { readInvalidations, validText } from "./memory-validity";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const CATALOG = ["", "apps/web", "packages/cli", "packages/cli/plugins"];

const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

/** A store with an encoding place: the repo's catalog and a working scope (A4 §2). */
function store(working?: string) {
  const dir = mkdtempSync(join(tmpdir(), "eden-slots-"));
  dirs.push(dir);
  process.env.EDEN_NOW = String(T0);
  const place =
    working === undefined
      ? undefined
      : { repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }), working: () => working };
  return openMemory({ dir, session: "s1", perRepo: true, ...(place ? { place } : {}) });
}

/** What the user typed, as the hook gives it to `observe`; `minutes` after T0. */
function typed(content: string, minutes = 0) {
  process.env.EDEN_NOW = String(T0 + minutes * 60_000);
  return { role: "user", content, src: "user" };
}

const live = (mem: ReturnType<typeof store>) => mem.memories().filter((row) => !superseded(row));
const keyed = (mem: ReturnType<typeof store>) => live(mem).filter((row) => row.slots?.length);
const said = (mem: ReturnType<typeof store>, words: string): MemoryRecord => {
  const row = mem.memories().find((r) => r.text.includes(words));
  if (!row) throw new Error(`no row says "${words}"`);
  return row;
};

describe("a typed slot statement is a keyed row (D6, D7)", () => {
  test("its slots are on the row; text the user did not type states none (A4 §3.0)", () => {
    const mem = store();
    mem.observe([typed("We use pnpm.")]);
    mem.observe([{ role: "assistant", content: "We use yarn in this repo." }]);
    expect(said(mem, "We use pnpm").slots).toEqual([{ k: "pkg.manager", v: "pnpm" }]);
    expect(said(mem, "yarn").slots).toBeUndefined();
  });

  test("a switch is a slot fact, not an episode, and keys its old value as invalidated", () => {
    const mem = store();
    mem.observe([typed("We switched from jest to vitest.")]);
    const row = said(mem, "vitest");
    expect(row.kind).toBe("fact");
    expect(row.slots).toEqual([{ k: "test.runner", v: "vitest", x: ["jest"] }]);
  });

  test("R3 E8: two `use` statements of two slots are two keys, and neither supersedes or tombstones the other", () => {
    const mem = store();
    mem.observe([typed("We use Redis for caching.", 0)]);
    mem.observe([typed("We use postgres for the db.", 1)]);
    mem.observe([typed("We use pnpm.", 2)]);
    // Durable rows keep the text without its closing stop.
    const texts = live(mem).map((row) => row.text);
    expect(texts).toContain("We use Redis for caching");
    expect(texts).toContain("We use postgres for the db");
    expect(texts).toContain("We use pnpm");
    for (const text of ["We use Redis for caching", "We use postgres for the db"])
      expect(scrubTombstonedIdentity(text, mem.dir)).toBe(text);
  });
});

describe("supersession by key (A4 §3.1–3.2)", () => {
  test("the same (scope, slot) with another value goes to history, in any phrasing; another scope's row stays", () => {
    const mem = store();
    mem.remember("In apps/web the database is postgres.", { tags: ["src:user"], scope: "apps/web" });
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.remember("The database is sqlite.", { tags: ["src:user"], scope: "packages/cli" });
    process.env.EDEN_NOW = String(T0 + 120_000);
    mem.remember("packages/cli uses mysql for its database.", { tags: ["src:user"], scope: "packages/cli" });
    expect(superseded(said(mem, "is sqlite"))).toBe(true);
    expect(superseded(said(mem, "postgres"))).toBe(false);
    // A4 §3.2: a different value at the same scope is a correction.
    expect(said(mem, "uses mysql").corrected).toBe(1);
    expect(said(mem, "is sqlite").corrected).toBeUndefined();
    expect(keyed(mem).map((row) => [row.scope, row.slots])).toEqual([
      ["apps/web", [{ k: "db.engine", v: "postgres" }]],
      ["packages/cli", [{ k: "db.engine", v: "mysql" }]],
    ]);
  });

  test("`use A, not B` invalidates B; a retraction invalidates with no successor", () => {
    const mem = store();
    mem.observe([typed("The formatter is prettier.", 0)]);
    mem.observe([typed("Use biome for formatting, not prettier.", 1)]);
    expect(superseded(said(mem, "is prettier"))).toBe(true);
    mem.observe([typed("We use yarn.", 2)]);
    mem.observe([typed("We don't use yarn anymore.", 3)]);
    expect(superseded(mem.memories().find((row) => row.text === "We use yarn")!)).toBe(true);
    // A retraction states a slot, not a rule: its "don't" is no rule word (D6).
    expect(said(mem, "don't use yarn").kind).toBe("fact");
    expect(keyed(mem).filter((row) => row.slots!.some((slot) => slot.k === "pkg.manager" && slot.v))).toEqual([]);
  });

  test("a row stating two slots goes to history only when both are superseded", () => {
    const mem = store();
    mem.observe([typed("The orm is drizzle and the database is postgres.", 0)]);
    mem.observe([typed("The orm is prisma.", 1)]);
    expect(superseded(said(mem, "drizzle"))).toBe(false);
    mem.observe([typed("We switched the database from postgres to sqlite.", 2)]);
    expect(superseded(said(mem, "drizzle"))).toBe(true);
  });

  test("an equal value writes no row; the visible row counts the restatement (A4 §3.2)", () => {
    const mem = store();
    mem.observe([typed("The package manager is pnpm.", 0)]);
    mem.observe([typed("we use pnpm here", 1)]);
    const rows = keyed(mem);
    expect(rows.map((row) => row.text)).toEqual(["The package manager is pnpm"]);
    expect(rows[0]!.reps).toBe(1);
    expect(mem.memories().some((row) => /we use pnpm here/i.test(row.text))).toBe(false);
  });
});

describe("a slot's default scope (D7, A4 §3.2)", () => {
  test("R3 E8 / ROADMAP: `we use pnpm here` typed in apps/web is pkg.manager=pnpm at the root", () => {
    const mem = store("apps/web");
    mem.observe([typed("we use pnpm here")]);
    const [row] = keyed(mem);
    expect(row?.slots).toEqual([{ k: "pkg.manager", v: "pnpm" }]);
    expect(row?.scope).toBe("");
  });

  test("P3.2's follow-up: two-clause and switch phrasings of a root slot are at the root too", () => {
    const mem = store("apps/web");
    mem.observe([typed("The package manager is pnpm, not npm.", 0)]);
    mem.observe([typed("We switched to bun.", 1)]);
    expect(said(mem, "pnpm, not npm").scope).toBe("");
    expect(said(mem, "switched to bun").scope).toBe("");
  });

  test("a root slot naming a scope is at that scope; once a scope has its own row, its next value goes there", () => {
    const mem = store("apps/web");
    mem.observe([typed("The package manager is pnpm.", 0)]);
    mem.observe([typed("In apps/web the package manager is yarn.", 1)]);
    mem.observe([typed("We use bun.", 2)]);
    expect(said(mem, "is yarn").scope).toBe("apps/web");
    expect(superseded(said(mem, "is yarn"))).toBe(true);
    expect(said(mem, "We use bun").scope).toBe("apps/web");
    expect(superseded(said(mem, "is pnpm"))).toBe(false);
  });

  test("a working slot is at the working scope", () => {
    const mem = store("packages/cli");
    mem.observe([typed("The database is sqlite.")]);
    expect(said(mem, "sqlite").scope).toBe("packages/cli");
  });
});

describe("D31: stale_for, at the superseded value's scope and its non-overriding descendants", () => {
  test("an older episode giving the old value is stale there, and not at a sibling; a history cue is the caller's", () => {
    const mem = store("packages/cli");
    mem.observe([{ role: "assistant", content: "Start postgres locally with docker compose up db.", src: "agent" }]);
    mem.observe([typed("packages/cli uses postgres for its database.", 1)]);
    mem.observe([typed("packages/cli switched its database from postgres to sqlite.", 2)]);
    const invalid = readInvalidations(mem.dir);
    const episode = said(mem, "docker compose");
    expect(validText(episode.text, episode.at, invalid, "packages/cli")).toBe("");
    expect(validText(episode.text, episode.at, invalid, "packages/cli/plugins")).toBe("");
    expect(validText(episode.text, episode.at, invalid, "apps/web")).toBe(episode.text);
    expect(superseded(said(mem, "uses postgres"))).toBe(true);
  });

  test("a root change leaves a descendant that overrides the slot as it is", () => {
    const mem = store("");
    mem.remember("In apps/web the database is mysql.", { tags: ["src:user"], scope: "apps/web" });
    process.env.EDEN_NOW = String(T0 + 60_000);
    mem.remember("The database is postgres.", { tags: ["src:user"], scope: "" });
    process.env.EDEN_NOW = String(T0 + 120_000);
    mem.remember("We switched the database from postgres to sqlite.", { tags: ["src:user"], scope: "" });
    const invalid = readInvalidations(mem.dir);
    const old = "Seed postgres before the tests.";
    expect(validText(old, T0, invalid, "packages/cli")).toBe("");
    expect(validText(old, T0, invalid, "apps/web")).toBe(old);
  });

  test("what is left of an older text's dropped item is not a bare list marker (P0.2 review round 4)", () => {
    const mem = store();
    mem.observe([typed("The database is SQLite.", 0)]);
    mem.observe([typed("We switched the database from SQLite to Postgres.", 1)]);
    const invalid = readInvalidations(mem.dir);
    expect(validText("1. The database is SQLite", T0, invalid)).toBe("");
    expect(validText("1. The database is SQLite. 2. Logs go to stdout.", T0, invalid)).toBe("2. Logs go to stdout.");
  });

  test("a common-word value is stale only beside its slot's words: `render` the verb is not the host", () => {
    const mem = store("");
    mem.observe([typed("We deploy to render.", 0)]);
    mem.observe([typed("We switched hosting from render to fly.io.", 1)]);
    const invalid = readInvalidations(mem.dir);
    expect(validText("Render the login form server-side.", T0, invalid, "")).toBe("Render the login form server-side.");
    expect(validText("The deploy target is render.", T0, invalid, "")).toBe("");
  });
});

describe("encoding a typed list (P0.2's follow-up, refiled to P3.3)", () => {
  test("a heading's numbered list ends at its line break: the next line is no part of its last item", () => {
    const mem = store();
    mem.observe([typed("Notes for this repo:\n1. The database is sqlite\n2. Logs go to stdout\nReply with just OK")]);
    const texts = mem.memories().map((row) => row.text);
    expect(texts.some((text) => /Logs go to stdout$/.test(text))).toBe(true);
    expect(texts.some((text) => /stdout Reply/.test(text) && !/^Notes for this repo/.test(text))).toBe(false);
    expect(keyed(mem).map((row) => row.slots)).toEqual([[{ k: "db.engine", v: "sqlite" }]]);
  });
});

describe("the same text typed in two folders (P3.2's follow-up)", () => {
  test("is a row at each folder's scope, not one row for both", () => {
    const mem = store("apps/web");
    mem.observe([typed("The database is postgres.", 0)]);
    const cli = openMemory({
      dir: mem.dir,
      session: "s2",
      perRepo: true,
      place: { repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }), working: () => "packages/cli" },
    });
    cli.observe([typed("The database is postgres.", 1)]);
    expect(
      keyed(cli)
        .map((row) => row.scope)
        .sort(),
    ).toEqual(["apps/web", "packages/cli"]);
  });
});

describe("forget --all-in (A6 §3) reaches keyed slot rows", () => {
  test("a scope's keyed slot rows go to history with its rules", () => {
    const mem = store();
    mem.remember("In apps/web the database is postgres.", { tags: ["src:user"], scope: "apps/web" });
    mem.remember("In packages/cli the database is sqlite.", { tags: ["src:user"], scope: "packages/cli" });
    expect(mem.forgetScope("apps/web")).toBe(1);
    expect(superseded(said(mem, "postgres"))).toBe(true);
    expect(superseded(said(mem, "sqlite"))).toBe(false);
  });
});
