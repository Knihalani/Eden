/**
 * P3.2 (A4 §2; D2, D4): a window's place from the paths its turns named and touched, the read set it makes, what a
 * row is visible from, the scope an encoded row is stored at, and the two-scope bullet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import { packetOf } from "./memory-hook-packet";
import { ledgerKey } from "./memory-ledger";
import {
  commonScope,
  namedScopes,
  namesRootSlot,
  readSetOf,
  recordPrompt,
  recordSubagentPaths,
  rowScope,
  scopeWeights,
  twoScopeNotes,
  visibleFrom,
  windowPaths,
  type PlacePaths,
} from "./memory-place";
import type { ProvenanceNote } from "./memory-provenance";
import { recordSupersession, readInvalidations, validText } from "./memory-validity";
import { compactContext, recordBatch, windowRecords } from "./memory-window";

const CATALOG = ["", "apps/web", "apps/api", "packages/cli"];

/** Paths are already relative to the repo's top here: a path's scope is its catalog prefix. */
function scopeOf(path: string): string | undefined {
  if (path.startsWith("/elsewhere/")) return undefined;
  return CATALOG.filter((scope) => !scope || path === scope || path.startsWith(`${scope}/`)).sort(
    (a, b) => b.length - a.length,
  )[0];
}

function paths(given: Partial<PlacePaths>): PlacePaths {
  return { prompt: [], batch: [], turns: [], bash: [], sub: [], ...given };
}

const readSet = (given: Partial<PlacePaths>) =>
  readSetOf(scopeWeights(paths(given), scopeOf), (scopes) => commonScope(scopes, CATALOG));

describe("D4's weights and read set", () => {
  test("prompt 3, the most recent batch 2, the last 3 turns 1, Bash 1, each distinct path once per source", () => {
    const weights = scopeWeights(
      paths({
        prompt: ["apps/web/a.ts", "apps/web/a.ts"],
        batch: ["packages/cli/x.ts"],
        turns: ["packages/cli/x.ts", "apps/api/y.ts"],
        bash: ["apps/api"],
      }),
      scopeOf,
    );
    expect(Object.fromEntries(weights.main)).toEqual({ "apps/web": 3, "packages/cli": 3, "apps/api": 2 });
  });

  test("every scope with ≥ 30% of the weight, at most 2, heaviest first", () => {
    expect(readSet({ prompt: ["apps/web/a.ts"], turns: ["packages/cli/x.ts"] })).toEqual(["apps/web"]);
    expect(readSet({ prompt: ["apps/web/a.ts", "packages/cli/x.ts"] })).toEqual(["apps/web", "packages/cli"]);
    expect(readSet({ turns: ["apps/web/a.ts"], prompt: ["packages/cli/x.ts", "packages/cli/y.ts"] })).toEqual([
      "packages/cli",
    ]);
    // Three scopes each above 30%: the two heaviest, of equal ones the first met.
    const three = readSet({ prompt: ["apps/web/a.ts", "apps/api/b.ts", "packages/cli/c.ts"] });
    expect(three).toEqual(["apps/web", "apps/api"]);
  });

  test("no scope reaching 30%: the scope owning the paths' common folder; no path at all: the root", () => {
    const spread = ["apps/web/a.ts", "apps/api/b.ts", "packages/cli/c.ts", "README.md"];
    expect(readSet({ turns: spread })).toEqual([""]);
    expect(commonScope(["apps/web", "apps/api"], CATALOG)).toBe("");
    expect(commonScope(["apps/web/x", "apps/web"], [...CATALOG, "apps/web/x"])).toBe("apps/web");
    expect(readSet({})).toEqual([""]);
  });

  test("a path of another repo is no place of this one", () => {
    expect(readSet({ prompt: ["/elsewhere/apps/web/a.ts"], turns: ["packages/cli/x.ts"] })).toEqual(["packages/cli"]);
  });

  test("subagent paths weigh 0.5, only while the main thread carries < 30% of all the weight (D2)", () => {
    const sub = ["apps/web/a.ts", "apps/web/b.ts", "apps/web/c.ts", "apps/web/d.ts"];
    // Main 1 of 3: a third, so the subagents' 2 do not count.
    expect(readSet({ turns: ["packages/cli/x.ts"], sub })).toEqual(["packages/cli"]);
    // Main 1 of 1 + 5: under 30%, so they do.
    const many = Array.from({ length: 10 }, (_, i) => `apps/web/f${i}.ts`);
    expect(readSet({ turns: ["packages/cli/x.ts"], sub: many })).toEqual(["apps/web"]);
    expect(readSet({ sub })).toEqual(["apps/web"]);
  });
});

describe("a window's paths, from ctx.log", () => {
  let win = "";
  beforeEach(() => {
    win = mkdtempSync(join(tmpdir(), "eden-place-win-"));
  });
  afterEach(() => rmSync(win, { recursive: true, force: true }));

  const batch = (paths: string[], bash: string[] = [], id = "p") =>
    recordBatch(win, { prompt_id: id, paths, bash, exit: [], sig: [] });

  test("the newest prompt's places, the newest batch, and the last 3 human turns by position", () => {
    recordPrompt(win, ["apps/api"], "p1");
    batch(["apps/api/old.ts"], [], "p1");
    recordPrompt(win, [], "p2");
    batch(["apps/web/a.ts"], ["packages/cli"], "p2");
    recordSubagentPaths(win, ["apps/web/sub.ts"]);
    recordPrompt(win, [], "p3");
    recordPrompt(win, ["packages/cli/x.ts"], "p4");
    batch(["packages/cli/y.ts"], [], "p4");
    expect(windowPaths(win)).toEqual({
      prompt: ["packages/cli/x.ts"],
      batch: ["packages/cli/y.ts"],
      turns: ["packages/cli/y.ts", "apps/web/a.ts"],
      bash: ["packages/cli"],
      sub: ["apps/web/sub.ts"],
    });
  });

  test("a window with no prompt record (a subagent's) reads all of it, and its task as its prompt", () => {
    batch(["apps/web/a.ts"]);
    batch(["apps/web/b.ts"]);
    expect(windowPaths(win, ["apps/web"])).toMatchObject({
      prompt: ["apps/web"],
      batch: ["apps/web/b.ts"],
      turns: ["apps/web/b.ts", "apps/web/a.ts"],
    });
  });

  test("each source reads its 64 newest distinct paths: one long turn's thousands cost no more", () => {
    recordPrompt(win, [], "p1");
    for (let n = 0; n < 500; n++) batch([`apps/web/f${n}.ts`, `packages/cli/g${n}.ts`], [`apps/api/h${n}`]);
    const read = windowPaths(win);
    expect([read.turns.length, read.bash.length]).toEqual([64, 64]);
    expect(read.turns[0]).toBe("apps/web/f499.ts");
  });

  test("a prompt record holds places only, never the prompt (X11), at most 8", () => {
    recordPrompt(
      win,
      Array.from({ length: 12 }, (_, i) => `apps/web/f${i}.ts`),
      "p1",
    );
    const [record] = windowRecords(win, "ctx.log");
    expect(Object.keys(record!).sort()).toEqual(["k", "paths", "prompt_id"]);
    expect(record!.paths).toHaveLength(8);
  });

  test("compaction keeps the last 3 human turns: from the third-newest prompt record on", () => {
    for (let turn = 1; turn <= 40; turn++) {
      recordPrompt(win, [`apps/web/t${turn}.ts`], `p${turn}`);
      batch(
        [`apps/web/${"x".repeat(150)}${turn}.ts`, ...Array(6).fill(`apps/api/${"y".repeat(150)}.ts`)],
        [],
        `p${turn}`,
      );
      recordSubagentPaths(win, [`apps/web/s${turn}.ts`]);
    }
    const before = windowPaths(win);
    compactContext(win);
    const kept = windowRecords(win, "ctx.log");
    expect(kept.filter((record) => record.k === "prompt").map((record) => record.prompt_id)).toEqual([
      "p38",
      "p39",
      "p40",
    ]);
    expect(kept).toHaveLength(9);
    expect(windowPaths(win)).toEqual(before);
  });
});

describe("A4 §2's visibility", () => {
  const row = (kind: string, scope?: string, extra: Partial<ProvenanceNote> = {}): ProvenanceNote => ({
    text: "x",
    kind,
    ...(scope === undefined ? {} : { scope }),
    ...extra,
  });
  const web = visibleFrom({ readSet: ["apps/web"], named: [] });
  const root = visibleFrom({ readSet: [""], named: [] });
  const rootNamingWeb = visibleFrom({ readSet: [""], named: ["apps/web"] });

  test("a fact, a policy or an intent: its scope and below; never a sibling, never above", () => {
    for (const fact of [row("fact", ""), row("fact", "apps/web"), row("constraint", ""), row("preference", "")])
      expect(web(fact)).toBe(true);
    expect(web(row("fact", "packages/cli"))).toBe(false);
    expect(web(row("constraint", "packages/cli"))).toBe(false);
    expect(root(row("fact", "apps/web"))).toBe(false);
    expect(visibleFrom({ readSet: ["apps/web/app"], named: [] })(row("fact", "apps/web"))).toBe(true);
  });

  test("an episode or a procedure: its scope only, and from an ancestor when the prompt names its scope", () => {
    expect(web(row("episode", "apps/web"))).toBe(true);
    expect(web(row("episode", ""))).toBe(false);
    expect(web(row("procedure", ""))).toBe(false);
    expect(web(row("episode", "packages/cli"))).toBe(false);
    expect(root(row("episode", "apps/web"))).toBe(false);
    expect(rootNamingWeb(row("episode", "apps/web"))).toBe(true);
    expect(rootNamingWeb(row("episode", "packages/cli"))).toBe(false);
  });

  test("a row written before P3.2 placed rows (no scope) stays visible everywhere", () => {
    expect(web(row("episode"))).toBe(true);
    expect(web(row("fact"))).toBe(true);
  });

  test("a two-scope read set sees each scope's rows", () => {
    const both = visibleFrom({ readSet: ["apps/web", "packages/cli"], named: [] });
    expect(both(row("episode", "packages/cli"))).toBe(true);
    expect(both(row("fact", "apps/web"))).toBe(true);
    expect(both(row("episode", "apps/api"))).toBe(false);
  });
});

describe("the scope an encoded row is stored at", () => {
  const top = "/repo";
  const at = (working: string) => ({ repo: () => ({ repo: "r", top, scopes: CATALOG }), working: () => working });

  test("the one scope its text names, else the working scope, and a rule the root", () => {
    expect(rowScope("In apps/web the auth provider is Clerk.", false, at("packages/cli"))).toBe("apps/web");
    expect(rowScope("Edit /repo/packages/cli/src/a.ts next.", false, at(""))).toBe("packages/cli");
    expect(rowScope("The tests are slow.", false, at("apps/api"))).toBe("apps/api");
    expect(rowScope("Never merge pull requests yourself.", true, at("apps/api"))).toBe("");
    expect(rowScope("Never edit packages/cli/migrations by hand.", true, at("apps/api"))).toBe("packages/cli");
  });

  test("D7's root slots go to the root unless the row names a scope", () => {
    expect(namesRootSlot("The package manager is pnpm.")).toBe(true);
    expect(namesRootSlot("We deploy to fly.io from main.")).toBe(true);
    expect(namesRootSlot("The auth provider is Clerk.")).toBe(false);
    expect(rowScope("The package manager is pnpm.", true, at("apps/web"))).toBe("");
    expect(rowScope("packages/cli uses yarn as its package manager.", true, at("apps/web"))).toBe("packages/cli");
  });

  test("of several, the working scope when it is one of them, else their common ancestor", () => {
    const both = "make apps/web/a.ts and packages/cli/b.ts behave the same";
    expect(rowScope(both, false, at("packages/cli"))).toBe("packages/cli");
    expect(rowScope(both, false, at("apps/api"))).toBe("");
  });

  test("names only catalog scopes other than the root: prose slashes and other places are none", () => {
    expect(namedScopes("and/or client/server, see packages/cli's README", CATALOG, top)).toEqual(["packages/cli"]);
    expect(namedScopes("/other/apps/web/a.ts docs/guide.md", CATALOG, top)).toEqual([]);
  });
});

describe("A4 §2's two-scope bullet", () => {
  const typed = (text: string, scope: string, kind = "fact", at = 1): ProvenanceNote => ({
    id: `${scope}:${text}`,
    text,
    kind,
    scope,
    tags: ["src:user"],
    at,
  });
  const web = typed("In apps/web the auth provider is Clerk", "apps/web");
  const cli = typed("packages/cli has no auth", "packages/cli", "episode", 2);
  const readSet = ["apps/web", "packages/cli"];

  test("a slot at one scope takes the other scope's value from its rows: one bullet, both rows its parts", () => {
    const [bullet, ...rest] = twoScopeNotes([web], readSet, (scope) => (scope === "packages/cli" ? [cli] : []));
    expect(rest).toEqual([]);
    expect(bullet).toMatchObject({
      text: "auth provider — apps/web: Clerk · packages/cli: has no auth",
      kind: "fact",
      tags: ["src:user"],
      at: 2,
    });
    expect(bullet!.parts).toEqual([web, cli]);
  });

  test("a candidate that is the other value is taken from the packet, once, with its label read past", () => {
    const labelled = { ...cli, text: "[episode · 1d · user] packages/cli has no auth" };
    const shown = twoScopeNotes([web, labelled], readSet, () => []);
    expect(shown.map((note) => note.text)).toEqual(["auth provider — apps/web: Clerk · packages/cli: has no auth"]);
  });

  test("a later row saying only a value the bullet gives is given by it (a prompt's row and its sentence's)", () => {
    const prompt = typed("packages/cli has no auth. Reply with just OK.", "packages/cli", "episode", 3);
    const sentence = { ...cli, text: "[episode · 1d · user] packages/cli has no auth" };
    const shown = twoScopeNotes([web, prompt, sentence], readSet, () => []);
    expect(shown.map((note) => note.text)).toEqual(["auth provider — apps/web: Clerk · packages/cli: has no auth"]);
    expect(shown[0]!.parts).toEqual([web, prompt]);
  });

  test("a one-clause slot gives its value; a longer row gives its sentence naming the subject", () => {
    const none = typed("In packages/cli the auth provider is none", "packages/cli");
    expect(twoScopeNotes([web], readSet, () => [none])[0]!.text).toBe(
      "auth provider — apps/web: Clerk · packages/cli: none",
    );
    const two = typed("packages/cli has no auth, and its database is sqlite", "packages/cli");
    expect(twoScopeNotes([web], readSet, () => [two])[0]!.text).toBe(
      "auth provider — apps/web: Clerk · packages/cli: has no auth, and its database is sqlite",
    );
    // A row of two clauses is no slot of its own: it takes no other value.
    const both = typed("In apps/web the auth provider is Clerk, and the database is postgres", "apps/web");
    expect(twoScopeNotes([both], readSet, () => [cli]).map((note) => note.text)).toEqual([both.text]);
  });

  test("a labelled note renders its scope after the packet label it was retrieved with (review round 1)", () => {
    const note = { ...typed("[episode · 1d · user] The login page redirects home", "apps/web", "episode") };
    const { packet } = packetOf(
      twoScopeNotes([note], readSet, () => []),
      2,
    );
    expect(packet).toContain("- apps/web: The login page redirects home");
    expect(packet).not.toContain("[episode");
  });

  test("a row naming the subject without stating it (a question, an instruction) gives no value (review round 1)", () => {
    for (const text of [
      "which auth does packages/cli use?",
      "make packages/cli/src/login.ts use the same auth as apps/web/app/login.ts",
    ])
      expect(twoScopeNotes([web], readSet, () => [typed(text, "packages/cli", "episode")])[0]!.text).toBe(web.text);
    const states = typed("The cli's auth is a static token", "packages/cli", "episode");
    expect(twoScopeNotes([web], readSet, () => [states])[0]!.text).toContain(
      "packages/cli: The cli's auth is a static",
    );
  });

  test("only what the user typed, a fact or an episode, gives the other value", () => {
    const agent = { ...cli, tags: ["src:agent"] };
    const rule = { ...typed("Never touch auth in packages/cli", "packages/cli", "constraint"), rules: [] };
    for (const other of [agent, rule]) expect(twoScopeNotes([web], readSet, () => [other])[0]!.text).toBe(web.text);
  });

  test("other candidates at either scope are labelled with it unless they name it; one scope changes nothing", () => {
    const plain = typed("The login page redirects home", "apps/web", "episode");
    const [labelled] = twoScopeNotes([plain], readSet, () => []);
    expect(labelled).toMatchObject({ text: "apps/web: The login page redirects home", parts: [plain] });
    expect(twoScopeNotes([web, plain], ["apps/web"], () => [cli])).toEqual([web, plain]);
    const updated = { ...web, update: { was: "Auth0" } };
    expect(twoScopeNotes([updated], readSet, () => [cli])).toEqual([updated]);
  });

  test("the ledger keys a slot by its scope (A4 §4: s:<scope>|<slot>); the root's key is unchanged", () => {
    const at = (scope?: string) =>
      ledgerKey({ text: "The auth provider is Clerk", kind: "fact", ...(scope === undefined ? {} : { scope }) }, "r");
    expect(at("apps/web").cid).toMatch(/^r\/s:apps\/web\|/);
    expect(at("packages/cli").cid).not.toBe(at("apps/web").cid);
    expect(at("").cid).toBe(at().cid);
    expect(at("").cid).toMatch(/^r\/s:[0-9a-f]+$/);
  });
});

describe("rows and scopes in the store (A4 §3.2)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eden-place-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const place = (working: string) => ({
    repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }),
    working: () => working,
  });
  const live = (rows: MemoryRecord[]) => rows.filter((row) => row.invalidAt === undefined && !row.invalidBy);

  test("an encoding place stores every row's scope, the root's as `\"\"`, and a bare episode keeps it on disk", () => {
    const mem = openMemory({ dir, perRepo: true, place: place("apps/web") });
    mem.observe([{ role: "user", content: "The login page redirects to the home page after a short delay." }]);
    mem.remember("Never merge pull requests yourself.", { kind: "constraint", tags: ["src:user"] });
    mem.close();
    const rows = openMemory({ dir, perRepo: true }).memories();
    expect(rows.map((row) => row.scope)).toEqual(rows.map((row) => (row.kind === "constraint" ? "" : "apps/web")));
    expect(rows.length).toBeGreaterThan(1);
  });

  test("a value at one scope does not supersede another scope's; at the same scope it does", () => {
    const mem = openMemory({ dir, perRepo: true });
    mem.remember("The database is postgres.", { tags: ["src:user"], scope: "apps/web" });
    mem.remember("The database is sqlite.", { tags: ["src:user"], scope: "packages/cli" });
    expect(live(mem.memories()).map((row) => row.text)).toEqual([
      "The database is postgres.",
      "The database is sqlite.",
    ]);
    mem.remember("The database is mysql.", { tags: ["src:user"], scope: "packages/cli" });
    expect(live(mem.memories()).map((row) => row.text)).toEqual([
      "The database is postgres.",
      "The database is mysql.",
    ]);
    mem.close();
  });

  test("a supersession holds at the superseded row's scope only (and where a row's scope is unknown)", () => {
    recordSupersession(dir, { subject: "auth provider", value: "Auth0" }, 10, undefined, "apps/web");
    const invalid = readInvalidations(dir);
    const said = "In packages/cli the auth provider is Auth0.";
    expect(validText(said, 1, invalid, "packages/cli")).toBe(said);
    expect(validText("The auth provider is Auth0.", 1, invalid, "apps/web")).toBe("");
    expect(validText("The auth provider is Auth0.", 1, invalid)).toBe("");
  });

  test("a reader's place leaves sibling rows out of retrieval, the rules the cue fires included", () => {
    const mem = openMemory({ dir, perRepo: true });
    mem.remember("The cache store for sessions is redis.", { tags: ["src:user"], scope: "apps/web" });
    mem.remember("The cache store for sessions is memcached.", { tags: ["src:user"], scope: "packages/cli" });
    const rule = { kind: "constraint", tags: ["src:user"], scope: "packages/cli" };
    mem.remember("Never merge pull requests in packages/cli yourself.", rule);
    const web = visibleFrom({ readSet: ["apps/web"], named: [] });
    const texts = (notes: MemoryRecord[]) => notes.map((note) => note.text).join("\n");
    const cue = [{ role: "user", content: "which cache store holds sessions? then merge the pull request" }];
    const got = texts(mem.recall(cue, undefined, web));
    expect(got).toContain("redis");
    expect(got).not.toContain("memcached");
    expect(got).not.toContain("Never merge");
    expect(texts(mem.taskNotes(["apps/web"], ["integrate"], web))).not.toContain("Never merge");
    mem.close();
  });
});
