/**
 * P3.5 (D5, A4 §2, §5.5): cascade with override for slot facts, typed and mined (a slot fact is visible at its scope
 * and in every descendant with no row of its own); a statement split by its slots' scopes shown only where every
 * value it states holds; a scope's own slot facts as a first touch's candidates; the ledger's first touches by epoch;
 * and `..` in a path a row names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GistStore } from "./gist-store";
import { openMemory } from "./index";
import { firstTouches, foldLedger, startEpoch } from "./memory-ledger";
import { namedScopes, scopeFacts, withoutOverridden } from "./memory-place";
import type { ProvenanceNote } from "./memory-provenance";
import { validText } from "./memory-validity";
import { SHADOW_LEDGER } from "./memory-window";
import { lightSleep } from "./sleep";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-cascade-"));
  dirs.push(dir);
  return dir;
}

const CATALOG = ["", "apps/web", "apps/web/app", "apps/api", "packages/cli"];

/** A typed fact keyed by its slots at a scope, as the store writes one (A4 §3.1). */
function typed(id: string, text: string, scope: string, slots: Record<string, string>, at = 1): ProvenanceNote {
  return {
    id,
    text,
    kind: "fact",
    tags: ["src:user"],
    at,
    scope,
    slots: Object.entries(slots).map(([k, v]) => ({ k: k as never, v })),
  };
}

const rootNode = typed("root", "We use node 20 across the repo.", "", { "node.version": "20" });
const webNode = typed("web", "apps/web runs node 22.", "apps/web", { "node.version": "22" }, 2);
const shown = (notes: ProvenanceNote[], live: ProvenanceNote[], readSet: string[]) =>
  withoutOverridden(notes, live, readSet).map((note) => note.id);

describe("D5: cascade with override, for typed slot facts (A5 `cascade`)", () => {
  const live = [rootNode, webNode];

  test("the root's value is visible where no folder below holds its own: packages/cli and the root", () => {
    expect(shown([rootNode], live, ["packages/cli"])).toEqual(["root"]);
    expect(shown([rootNode], live, [""])).toEqual(["root"]);
  });

  test("a folder with its own value overrides it, alone or in a two-scope read set, and so do its subfolders", () => {
    expect(shown([rootNode], live, ["apps/web"])).toEqual([]);
    expect(shown([rootNode], live, ["apps/web", "packages/cli"])).toEqual([]);
    expect(shown([rootNode], live, ["packages/cli", "apps/web"])).toEqual([]);
    expect(shown([rootNode], live, ["apps/web/app"])).toEqual([]);
    expect(shown([webNode], live, ["apps/web"])).toEqual(["web"]);
  });

  test("a folder's value deeper than the reader overrides nothing there", () => {
    const appNode = typed("app", "apps/web/app runs node 23.", "apps/web/app", { "node.version": "23" }, 3);
    expect(shown([rootNode, webNode], [rootNode, webNode, appNode], ["apps/web"])).toEqual(["web"]);
    expect(shown([webNode], [rootNode, webNode, appNode], ["apps/web/app"])).toEqual([]);
  });

  test("a value of another slot overrides nothing; a row stating two slots goes when either is overridden (G2)", () => {
    const webDb = typed("webdb", "apps/web uses postgres.", "apps/web", { "db.engine": "postgres" }, 2);
    expect(shown([rootNode], [rootNode, webDb], ["apps/web"])).toEqual(["root"]);
    const both = typed("both", "We use node 20 and postgres.", "", { "node.version": "20", "db.engine": "postgres" });
    expect(shown([both], [both, webNode], ["apps/web"])).toEqual([]);
    expect(shown([both], [both, webNode], ["packages/cli"])).toEqual(["both"]);
  });

  test("a mined value is overridden by a typed one below it, and a typed one by a mined one below it", () => {
    const minedWeb = { ...webNode, id: "mined", tags: ["src:tool"], cite: ["apps/web/.nvmrc"] };
    expect(shown([rootNode], [rootNode, minedWeb], ["apps/web"])).toEqual([]);
    const untypedWeb = { ...webNode, id: "said", tags: ["src:agent"] };
    expect(shown([rootNode], [rootNode, untypedWeb], ["apps/web"])).toEqual(["root"]);
  });

  test("a value ended at its own scope is validity's, clause by clause, not D5's; unknown scopes are kept", () => {
    const newerRoot = typed("new", "We moved to node 22.", "", { "node.version": "22" }, 5);
    expect(shown([rootNode], [rootNode, newerRoot], ["packages/cli"])).toEqual(["root"]);
    const unplaced = { ...rootNode, id: "unplaced", scope: undefined };
    expect(shown([unplaced], [unplaced, webNode], ["apps/web"])).toEqual(["unplaced"]);
    const episode = { ...rootNode, id: "ep", kind: "episode", slots: undefined };
    expect(shown([episode], [episode, webNode], ["apps/web"])).toEqual(["ep"]);
  });
});

describe("a statement split by its slots' scopes (P3.3's follow-up): shown where every value it states holds", () => {
  // "we use pnpm and vitest" typed in apps/web: the package manager at the root, the test runner at apps/web.
  const text = "We use pnpm and vitest.";
  const rootPart = typed("p-root", text, "", { "pkg.manager": "pnpm" });
  const webPart = typed("p-web", text, "apps/web", { "test.runner": "vitest" });
  const live = [rootPart, webPart];

  test("at apps/web both values hold; at a sibling or the root the runner does not, so the text is not shown", () => {
    expect(shown([rootPart, webPart], live, ["apps/web"])).toEqual(["p-root", "p-web"]);
    expect(shown([rootPart], live, ["packages/cli"])).toEqual([]);
    expect(shown([rootPart], live, [""])).toEqual([]);
  });

  test("a sibling holding the same runner of its own shows it; one holding another does not", () => {
    const cliVitest = typed("c1", "packages/cli uses vitest.", "packages/cli", { "test.runner": "vitest" }, 3);
    expect(shown([rootPart], [...live, cliVitest], ["packages/cli"])).toEqual(["p-root"]);
    const cliJest = typed("c2", "packages/cli uses jest.", "packages/cli", { "test.runner": "jest" }, 3);
    expect(shown([rootPart], [...live, cliJest], ["packages/cli"])).toEqual([]);
  });
});

describe("A4 §5.5: a scope's own slot facts, a first touch's candidates", () => {
  const cli = typed("cli", "packages/cli has no auth, and its database is sqlite.", "packages/cli", {
    "db.engine": "sqlite",
  });
  const minedCli = {
    ...typed("m", "In packages/cli the test runner is vitest", "packages/cli", { "test.runner": "vitest" }, 4),
    tags: ["src:tool"],
    cite: ["packages/cli/package.json"],
  };
  const rows: ProvenanceNote[] = [
    rootNode,
    webNode,
    cli,
    minedCli,
    { ...cli, id: "agent", tags: ["src:agent"], at: 9 },
    { id: "ep", text: "packages/cli's tests are flaky", kind: "episode", tags: ["src:user"], scope: "packages/cli" },
    { id: "rule", text: "Never edit packages/cli/migrations.", kind: "constraint", scope: "packages/cli", rules: [{}] },
  ] as ProvenanceNote[];

  test("the scope's own keyed facts, typed or cited, newest first; no ancestor's, episode, rule or untyped row", () => {
    expect(scopeFacts(rows, "packages/cli").map((row) => row.id)).toEqual(["m", "cli"]);
    expect(scopeFacts(rows, "apps/web").map((row) => row.id)).toEqual(["web"]);
    expect(scopeFacts(rows, "apps/api")).toEqual([]);
  });
});

describe("A4 §5.5: a window's first touches, by epoch", () => {
  test("a scope is new once per epoch; a compaction or a clear makes it new again", () => {
    const win = tempDir();
    expect(firstTouches(win, ["packages/cli", "apps/web", "packages/cli"])).toEqual(["packages/cli", "apps/web"]);
    expect(firstTouches(win, ["packages/cli"])).toEqual([]);
    expect(firstTouches(win, ["apps/web", "apps/api"])).toEqual(["apps/api"]);
    startEpoch(win, "compact", 100);
    expect(firstTouches(win, ["packages/cli"])).toEqual(["packages/cli"]);
  });

  test("touches survive a fold, and the ledger keeps them hashed: no path is written (X11)", () => {
    const win = tempDir();
    firstTouches(win, ["packages/cli"]);
    expect(foldLedger(win, "delivery.log")).toBe(true);
    expect(firstTouches(win, ["packages/cli"])).toEqual([]);
    const files = readdirSync(win).map((name) => readFileSync(join(win, name), "utf8"));
    expect(files.join("\n")).not.toContain("packages");
    startEpoch(win, "clear", 0);
    expect(foldLedger(win, "delivery.log")).toBe(true);
    expect(firstTouches(win, ["packages/cli"])).toEqual(["packages/cli"]);
  });

  test("a shadow point reads the live touches and writes its own to the shadow ledger (X7)", () => {
    const win = tempDir();
    firstTouches(win, ["apps/web"]);
    expect(firstTouches(win, ["apps/web", "packages/cli"], SHADOW_LEDGER)).toEqual(["packages/cli"]);
    expect(firstTouches(win, ["packages/cli"])).toEqual(["packages/cli"]);
    expect(firstTouches(win, ["packages/cli"], SHADOW_LEDGER)).toEqual([]);
  });
});

describe("`..` in a path a row names (P3.2's follow-up)", () => {
  const top = "/repo";

  test("each reading is resolved, and one that leaves the repo names nothing", () => {
    expect(namedScopes("see ../../packages/cli/src/x.ts", CATALOG, top, "apps/web")).toEqual(["packages/cli"]);
    expect(namedScopes("see ../api/src/x.ts", CATALOG, top, "apps/web")).toEqual(["apps/api"]);
    expect(namedScopes("see ../other-repo/x.ts", CATALOG, top)).toEqual([]);
    expect(namedScopes("see /repo/apps/web/../../packages/cli/a.ts", CATALOG, top)).toEqual(["packages/cli"]);
    expect(namedScopes("see ./packages/cli/a.ts", CATALOG, top)).toEqual(["packages/cli"]);
  });
});

describe("a clause's own folder, read with the scope catalog (P3.3's follow-up)", () => {
  const ended = [
    { k: "retract" as const, o: "postgres", t: 10, f: "postgres", slot: "db.engine" as const, in: "packages/cli" },
  ];
  const read = (text: string, catalog?: readonly string[]) =>
    validText(text, 1, ended, "packages/cli", ["packages/cli"], catalog);

  test("a path in no folder's scope, an absolute path or prose with a slash is no folder: the clause is the row's", () => {
    for (const text of [
      "src/db.ts opens a postgres database.",
      "/home/me/db.ts opens a postgres database.",
      "ci/cd runs against the postgres database.",
    ]) {
      expect(read(text, CATALOG)).toBe("");
      expect(read(text)).toBe(text);
    }
  });

  test("a clause opening with a scope, or a path in one, is that folder's", () => {
    expect(read("apps/web uses the postgres database.", CATALOG)).toBe("apps/web uses the postgres database.");
    expect(read("apps/web/app/db.ts opens the postgres database.", CATALOG)).toBe(
      "apps/web/app/db.ts opens the postgres database.",
    );
    expect(read("packages/cli/src/db.ts opens the postgres database.", CATALOG)).toBe("");
  });
});

describe("the light sleep's gist states each scope's legacy winner by its scope (P3.2's and P3.3's follow-up)", () => {
  const T0 = Date.parse("2026-10-01T09:00:00.000Z");
  const savedNow = process.env.EDEN_NOW;
  afterEach(() => {
    if (savedNow === undefined) delete process.env.EDEN_NOW;
    else process.env.EDEN_NOW = savedNow;
  });
  function store(working: string, dir: string) {
    const place = { repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }), working: () => working };
    return openMemory({ dir, session: "s1", perRepo: true, place });
  }
  const typedAt = (content: string, minutes: number) => {
    process.env.EDEN_NOW = String(T0 + minutes * 60_000);
    return { role: "user", content, src: "user" };
  };

  test("a fact of no D7 slot competes at its own scope only, and the gist names the folder it holds in", () => {
    const dir = tempDir();
    store("apps/web", dir).observe([typedAt("The cache is Redis.", 0)]);
    const cli = store("packages/cli", dir);
    cli.observe([typedAt("The cache is Memcached.", 1)]);
    lightSleep(cli as never, "s1");
    const gist = new GistStore(dir).latest("s1", 1)[0]?.text ?? "";
    expect(gist).toContain("In apps/web, cache is Redis");
    expect(gist).toContain("In packages/cli, cache is Memcached");
  });
});
