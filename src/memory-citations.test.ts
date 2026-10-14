/**
 * P3.4's citations in the store (D8, D31, A4 §3.1–3.2): what a reading of the repo's files changes by key. A new value
 * is a cited `src:tool` row that supersedes the old one at its scope and makes text carrying it stale there; the same
 * value changes nothing; a value the user typed after the files' last reading stays; a failed citation invalidates
 * the fact with no successor. Then delivery: a cited row is a slot fact (the gate admits it), cites its files, is
 * found by its slot's words or the slot detector, not by its folder's name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemory, superseded, type MemoryRecord } from "./index";
import {
  applyMined,
  citationChanges,
  readCitations,
  repoRelative,
  scopesCiting,
  watchPaths,
  WATCH_LIMIT,
  type Citation,
} from "./memory-citations";
import { admitNotes } from "./memory-gate";
import { withoutOverridden } from "./memory-place";
import { declarativeBullet } from "./memory-hook-packet";
import type { MinedFact, Reading } from "./memory-repo-facts";
import { cuedSlots } from "./memory-slots";
import { readInvalidations, validText } from "./memory-validity";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const MIN = 60_000;
const CATALOG = ["", "apps/web", "packages/cli"];

const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

function at(minutes: number): number {
  process.env.EDEN_NOW = String(T0 + minutes * MIN);
  return T0 + minutes * MIN;
}

/** The checkout the files are read from: every file a test cites is there, until a test removes it. */
let checkout = "";

function store(working = "") {
  const dir = mkdtempSync(join(tmpdir(), "eden-citations-"));
  dirs.push(dir);
  checkout = join(dir, "checkout");
  for (const file of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "apps/web/package.json"]) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    writeFileSync(join(checkout, file), "{}\n");
  }
  at(0);
  const place = { repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }), working: () => working };
  return openMemory({ dir, session: "s1", perRepo: true, place });
}

const fact = (scope: string, slot: MinedFact["slot"], value: string, files: string[]): MinedFact => ({
  scope,
  slot,
  value,
  files,
});
const npm = fact("", "pkg.manager", "npm", ["package-lock.json"]);
const pnpm = fact("", "pkg.manager", "pnpm", ["pnpm-lock.yaml"]);
const clerk = fact("apps/web", "auth.provider", "clerk", ["apps/web/package.json"]);

/** A reading of the checkout's files: what they state, and the slots they are torn on. */
const read = (facts: MinedFact[], torn: Reading["torn"] = [], scopes = CATALOG): Reading => ({
  top: checkout,
  scopes,
  facts,
  torn,
});

type Mem = ReturnType<typeof store>;
const live = (mem: Mem) => mem.memories().filter((row) => !superseded(row));
const keyedLive = (mem: Mem) => live(mem).filter((row) => row.slots?.length);
const values = (mem: Mem) =>
  keyedLive(mem).map((row) => `${row.scope ?? "?"}|${row.slots!.map((s) => `${s.k}=${s.v}`).join(",")}`);
const typed = (mem: Mem, content: string, minutes: number) => {
  at(minutes);
  mem.observe([{ role: "user", content, src: "user" }]);
};

describe("a reading of the files, applied by key (A4 §3.2)", () => {
  test("a new value is a cited src:tool row at its folder's scope; the same reading again writes nothing", () => {
    const mem = store();
    applyMined(mem, read([npm, clerk]), undefined, at(1));
    const rows = keyedLive(mem);
    expect(rows.map((row) => [row.text, row.tags, row.scope, row.cite])).toEqual([
      ["The package manager is npm", ["src:tool"], "", ["package-lock.json"]],
      ["In apps/web the auth provider is clerk", ["src:tool"], "apps/web", ["apps/web/package.json"]],
    ]);
    expect(readCitations(mem.dir).map((c) => [c.scope, c.slot, c.value, c.checked])).toEqual([
      ["", "pkg.manager", "npm", T0 + MIN],
      ["apps/web", "auth.provider", "clerk", T0 + MIN],
    ]);
    applyMined(mem, read([npm, clerk]), undefined, at(2));
    expect(mem.memories()).toHaveLength(2);
    expect(readCitations(mem.dir).every((c) => c.checked === T0 + 2 * MIN)).toBe(true);
  });

  test("a changed value supersedes the old one at its scope, and text carrying the old value is stale there", () => {
    const mem = store();
    applyMined(mem, read([npm]), undefined, at(1));
    typed(mem, "I ran npm install and it worked.", 2);
    applyMined(mem, read([pnpm]), undefined, at(3));
    expect(values(mem)).toEqual(["|pkg.manager=pnpm"]);
    const invalid = readInvalidations(mem.dir);
    expect(validText("I ran npm install and it worked.", T0 + 2 * MIN, invalid, "")).toBe("");
  });

  test("a value the user typed after the files' last reading stays when the files change (A4 §3.1)", () => {
    const mem = store();
    applyMined(mem, read([pnpm]), undefined, at(1));
    typed(mem, "We use bun as the package manager.", 2);
    expect(values(mem)).toEqual(["|pkg.manager=bun"]);
    applyMined(mem, read([pnpm]), undefined, at(3));
    expect(values(mem)).toEqual(["|pkg.manager=bun"]);
    applyMined(mem, read([fact("", "pkg.manager", "yarn", ["yarn.lock"])]), undefined, at(4));
    expect(values(mem)).toEqual(["|pkg.manager=yarn"]);
  });

  test("a statement beats a value read for the first time; a later change of the files beats the statement", () => {
    const mem = store();
    typed(mem, "We use bun as the package manager.", 1);
    applyMined(mem, read([pnpm]), undefined, at(2));
    expect(values(mem)).toEqual(["|pkg.manager=bun"]);
    applyMined(mem, read([npm]), undefined, at(3));
    expect(values(mem)).toEqual(["|pkg.manager=npm"]);
    typed(mem, "We switched to bun.", 4);
    applyMined(mem, read([fact("", "pkg.manager", "yarn", ["yarn.lock"])]), undefined, at(5));
    expect(values(mem)).toEqual(["|pkg.manager=bun"]);
  });

  test("an equal typed value writes no row and becomes cited; a failed citation then ends it", () => {
    const mem = store("apps/web");
    typed(mem, "In apps/web the auth provider is Clerk.", 1);
    applyMined(mem, read([clerk]), undefined, at(2));
    expect(keyedLive(mem).map((row) => row.text)).toEqual(["In apps/web the auth provider is Clerk"]);
    applyMined(mem, read([]), undefined, at(3));
    expect(keyedLive(mem)).toEqual([]);
    expect(readCitations(mem.dir).map((c) => [c.slot, c.value, c.failed])).toEqual([["auth.provider", "clerk", true]]);
    const invalid = readInvalidations(mem.dir);
    expect(validText("We moved apps/web to Clerk last week.", T0 + MIN, invalid, "apps/web")).toBe("");
  });

  test("a failed citation spares a value the user typed after the files' last reading", () => {
    const mem = store("apps/web");
    applyMined(mem, read([clerk]), undefined, at(1));
    typed(mem, "In apps/web the auth provider is Auth0.", 2);
    applyMined(mem, read([]), undefined, at(3));
    expect(values(mem)).toEqual(["apps/web|auth.provider=auth0"]);
  });

  test("a failed citation keeps a row's other slots", () => {
    const mem = store("apps/web");
    typed(mem, "In apps/web the auth provider is Clerk, and the database is postgres.", 1);
    applyMined(mem, read([clerk]), undefined, at(2));
    applyMined(mem, read([]), undefined, at(3));
    expect(keyedLive(mem).map((row) => row.text)).toEqual([
      "In apps/web the auth provider is Clerk, and the database is postgres",
    ]);
    const invalid = readInvalidations(mem.dir);
    const text = "In apps/web the auth provider is Clerk, and the database is postgres.";
    expect(validText(text, T0 + MIN, invalid, "apps/web")).not.toContain("Clerk");
  });

  test("a cited file gone, or torn evidence, ends only the mined value: the typed one stays, nothing turns stale", () => {
    const mem = store();
    typed(mem, "We use npm as the package manager.", 1);
    applyMined(mem, read([npm]), undefined, at(2));
    rmSync(join(checkout, "package-lock.json"));
    applyMined(mem, read([]), undefined, at(3));
    expect(values(mem)).toEqual(["|pkg.manager=npm"]);
    expect(readInvalidations(mem.dir)).toEqual([]);
    applyMined(mem, read([], [{ scope: "", slot: "pkg.manager" }]), undefined, at(4));
    expect(values(mem)).toEqual(["|pkg.manager=npm"]);
  });

  test("a failed citation stays watched, and its value read again is cited anew", () => {
    const mem = store();
    applyMined(mem, read([npm]), undefined, at(1));
    rmSync(join(checkout, "package-lock.json"));
    applyMined(mem, read([]), undefined, at(2));
    expect(values(mem)).toEqual([]);
    expect(watchPaths(readCitations(mem.dir), "/repo")).toEqual(["/repo/package-lock.json"]);
    writeFileSync(join(checkout, "package-lock.json"), "{}\n");
    applyMined(mem, read([npm]), undefined, at(3));
    expect(values(mem)).toEqual(["|pkg.manager=npm"]);
    expect(readCitations(mem.dir)[0]?.failed).toBeUndefined();
  });

  test("reading some folders leaves the others' citations; reading all fails a folder no longer read", () => {
    const known: Citation[] = [
      { ...npm, checked: T0 },
      { ...clerk, checked: T0 },
    ];
    store();
    const some = citationChanges(known, read([]), [], T0 + MIN, ["apps/web"]);
    expect(some.fail.map(({ citation, sure }) => [citation.slot, sure])).toEqual([["auth.provider", true]]);
    expect(some.kept.map((c) => [c.slot, c.failed])).toEqual([
      ["pkg.manager", undefined],
      ["auth.provider", true],
    ]);
    const all = citationChanges(known, read([npm]), [], T0 + MIN);
    expect(all.fail.map(({ citation }) => citation.slot)).toEqual(["auth.provider"]);
    const again = citationChanges(all.kept, read([npm]), [], T0 + 2 * MIN);
    expect(again.fail).toEqual([]);
    expect(again.kept.find((c) => c.slot === "auth.provider")?.failed).toBe(true);
    const gone = citationChanges(again.kept, read([npm], [], [""]), [], T0 + 3 * MIN);
    expect(gone.kept.map((c) => c.slot)).toEqual(["pkg.manager"]);
  });
});

describe("delivery of a cited fact", () => {
  test("the gate admits it as a slot fact, and its bullet names its files (A6 §2.1)", () => {
    const mem = store();
    applyMined(mem, read([pnpm]), undefined, at(1));
    const row = keyedLive(mem)[0]!;
    expect(admitNotes([row], { prompt: "set up the repo" })).toEqual([row]);
    expect(declarativeBullet(row, T0 + 61 * MIN)).toBe("The package manager is pnpm (from pnpm-lock.yaml, 1 hour ago)");
  });

  test("it is found by its slot's words, not by its folder's name", () => {
    const mem = store("apps/web");
    applyMined(mem, read([clerk]), undefined, at(1));
    expect(mem.relevant("which auth provider does apps/web use?").map((row) => row.text)).toEqual([
      "In apps/web the auth provider is clerk",
    ]);
    expect(mem.relevant("open apps/web/app/login.ts")).toEqual([]);
  });

  test("the slot detector's seed finds the package manager by key (R2 §6.1b)", () => {
    expect(cuedSlots("install the dependencies")).toEqual(["pkg.manager"]);
    expect(cuedSlots("add a package for dates")).toEqual(["pkg.manager"]);
    expect(cuedSlots("the deps are out of date, bump them")).toEqual(["pkg.manager"]);
    expect(cuedSlots("fix the login redirect")).toEqual([]);
    expect(cuedSlots("which package should own this helper?")).toEqual([]);
    expect(cuedSlots("remove the circular dependency between the parser and the lexer")).toEqual([]);
    expect(cuedSlots("add the package name to the error message")).toEqual([]);
    expect(cuedSlots("reinstall node_modules from the lockfile")).toEqual(["pkg.manager"]);
    const mem = store();
    applyMined(mem, read([pnpm]), undefined, at(1));
    const notes = mem.recall([{ role: "user", content: "install the dependencies" }]);
    expect(notes.map((note: MemoryRecord) => note.cite)).toEqual([["pnpm-lock.yaml"]]);
  });
});

describe("D5's override for mined facts (withoutOverridden)", () => {
  const rootNode: MemoryRecord = {
    id: "n",
    text: "The node version is 20",
    kind: "fact",
    tags: ["src:tool"],
    at: T0,
    scope: "",
    slots: [{ k: "node.version", v: "20" }],
    cite: [".nvmrc"],
  };
  const webNode: MemoryRecord = {
    id: "w",
    text: "apps/web runs node 22",
    kind: "fact",
    tags: ["src:user"],
    at: T0 + MIN,
    scope: "apps/web",
    slots: [{ k: "node.version", v: "22" }],
  };
  const kept = (readSet: string[]) => withoutOverridden([rootNode], [rootNode, webNode], readSet).length;

  test("a folder of the read set with its own value drops the root's mined value, whatever the other folder", () => {
    expect(kept(["apps/web"])).toBe(0);
    expect(kept(["apps/web", "packages/cli"])).toBe(0);
    expect(kept(["packages/cli", "apps/web"])).toBe(0);
  });

  test("a read set holding the fact's own folder and an overriding one drops it too (review round 4)", () => {
    expect(kept(["", "apps/web"])).toBe(0);
    expect(kept(["apps/web", ""])).toBe(0);
    expect(kept([])).toBe(1);
    expect(kept(["", "packages/cli"])).toBe(1);
  });

  test("a read set with no overriding folder keeps it; since P3.5 a typed row is overridden the same way (D5)", () => {
    expect(kept(["packages/cli"])).toBe(1);
    expect(kept([""])).toBe(1);
    const typedRoot = { ...rootNode, tags: ["src:user"], cite: undefined };
    expect(withoutOverridden([typedRoot], [typedRoot, webNode], ["apps/web"])).toHaveLength(0);
    expect(withoutOverridden([typedRoot], [typedRoot, webNode], ["packages/cli"])).toHaveLength(1);
  });
});

describe("watch paths and re-checks (D31, R0 F29)", () => {
  test("every cited file, absolute, newest-cited first, each once, at most 200", () => {
    const citations: Citation[] = [
      { ...npm, checked: T0 },
      { ...clerk, checked: T0 + MIN },
      { ...fact("apps/web", "framework", "next.js", ["apps/web/package.json"]), checked: T0 + MIN },
    ];
    expect(watchPaths(citations, "/repo")).toEqual(["/repo/apps/web/package.json", "/repo/package-lock.json"]);
    const many = Array.from({ length: 300 }, (_, i) => ({ ...npm, files: [`f${i}`], checked: T0 + i }));
    expect(watchPaths(many, "/repo")).toHaveLength(WATCH_LIMIT);
    expect(watchPaths(many, "/repo")[0]).toBe("/repo/f299");
  });

  test("a changed file's citing folders, and paths relative to the checkout", () => {
    const citations: Citation[] = [
      { ...npm, checked: T0 },
      { ...clerk, checked: T0 },
    ];
    expect(scopesCiting(citations, "apps/web/package.json")).toEqual(["apps/web"]);
    expect(scopesCiting(citations, "README.md")).toEqual([]);
    expect(repoRelative("/repo", "/repo/apps/web/package.json")).toBe("apps/web/package.json");
    expect(repoRelative("/repo", "/other/package.json")).toBeUndefined();
    expect(repoRelative("/repo", "/repo")).toBeUndefined();
  });
});
