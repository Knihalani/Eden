/**
 * P3.3 review probes (slice-reviewer, code review round 1), kept as regression tests: false slots that would supersede
 * a true value, the session gist's values by folder, and a statement of a root and a working slot typed in a folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GistStore } from "./gist-store";
import { openMemory, superseded } from "./index";
import { readInvalidations, validText } from "./memory-validity";
import { lightSleep } from "./sleep";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const CATALOG = ["", "apps/web", "packages/cli", "packages/cli/plugins"];
const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

function store(working?: string, dir?: string, session = "s1") {
  if (!dir) dirs.push((dir = mkdtempSync(join(tmpdir(), "eden-slot-review-"))));
  const place =
    working === undefined
      ? undefined
      : { repo: () => ({ repo: "r", top: "/repo", scopes: CATALOG }), working: () => working };
  return openMemory({ dir, session, perRepo: true, ...(place ? { place } : {}) });
}

function typed(content: string, minutes = 0) {
  process.env.EDEN_NOW = String(T0 + minutes * 60_000);
  return { role: "user", content, src: "user" };
}

const live = (mem: ReturnType<typeof store>) => mem.memories().filter((row) => !superseded(row));
const liveSlot = (mem: ReturnType<typeof store>, k: string) =>
  live(mem)
    .filter((row) => row.slots?.some((ref) => ref.k === k && ref.v !== undefined))
    .map((row) => row.text);

describe("round 1: false slots never supersede a true value", () => {
  for (const [said, k] of [
    ["I'm running npm install and it fails.", "pkg.manager"],
    ["Use the npm registry for this.", "pkg.manager"],
    ["We don't run jest locally.", "test.runner"],
    ["We no longer need jest mocks.", "test.runner"],
    ["We dropped the jest config.", "test.runner"],
    ["We're not using Vercel previews anymore.", "deploy.target"],
    ["The deploy is Friday.", "deploy.target"],
    ["We deploy the storybook to Chromatic.", "deploy.target"],
  ] as const)
    test(`"${said}" leaves the live ${k}`, () => {
      const mem = store("");
      const first =
        k === "pkg.manager" ? "We use pnpm." : k === "test.runner" ? "We use jest." : "We deploy to Vercel.";
      mem.observe([typed(first, 0)]);
      mem.observe([typed(said, 1)]);
      expect(liveSlot(mem, k)).toEqual([first.replace(/\.$/, "")]);
    });

  test("two qualified deploy subjects key nothing, and neither takes the other's place", () => {
    const mem = store("");
    mem.observe([typed("The frontend deploys to Vercel.", 0)]);
    mem.observe([typed("The API deploys to Fly.", 1)]);
    expect(liveSlot(mem, "deploy.target")).toEqual([]);
    expect(live(mem).map((row) => row.text)).toEqual(
      expect.arrayContaining(["The frontend deploys to Vercel", "The API deploys to Fly"]),
    );
  });
});

describe("round 1: the session gist states each folder's own value", () => {
  test("a cli switch leaves apps/web's value, in the gist and in a clause naming apps/web read without a scope", () => {
    const web = store("apps/web");
    web.observe([typed("The database is postgres.", 0)]);
    const cli = store("packages/cli", web.dir);
    cli.observe([typed("The database is postgres.", 1)]);
    cli.observe([typed("We switched the database from postgres to sqlite.", 2)]);
    const invalid = readInvalidations(cli.dir);
    expect(validText("The database is postgres", T0, invalid, "apps/web")).toBe("The database is postgres");
    expect(validText("In apps/web the database is postgres", T0, invalid)).toBe("In apps/web the database is postgres");
    lightSleep(cli as never, "s1");
    const gist = new GistStore(cli.dir).latest("s1", 1)[0]?.text ?? "";
    expect(gist).toContain("In packages/cli the database is sqlite");
    expect(gist).toContain("In apps/web the database is postgres");
  });
});

describe("round 1: a statement of a root and a working slot (D7's default scopes)", () => {
  test("typed in apps/web, the root slot is keyed at the root and the working slot at apps/web", () => {
    const mem = store("apps/web");
    mem.observe([typed("We use pnpm and vitest.", 0)]);
    const keyed = live(mem)
      .filter((row) => row.slots?.length)
      .map((row) => [row.scope, row.slots!.map((ref) => ref.k)]);
    expect(keyed).toEqual(
      expect.arrayContaining([
        ["", ["pkg.manager"]],
        ["apps/web", ["test.runner"]],
      ]),
    );
    expect(keyed).toHaveLength(2);
    // The next root statement typed there stays at the root: apps/web has no package manager of its own.
    mem.observe([typed("We use yarn.", 1)]);
    expect(live(mem).find((row) => row.text === "We use yarn")?.scope).toBe("");
  });
});
