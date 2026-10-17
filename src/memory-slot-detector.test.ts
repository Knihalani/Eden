/**
 * P4.4: A4 §5.1 step 4a's slot detector (R2 §6.1b, A7 §1 layer 2): a cue's slots, from a seed lexicon calibrated so no
 * prompt of the silence set names a slot, from any alias of a slot in a cue about the user's own project, and from the
 * setup bundle (A7 §7); each slot's live value is looked up by key, whatever words the cue shares with the row.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import seeds from "./memory-silence-seeds.json";
import { cuedSlots, SETUP_BUNDLE } from "./memory-slots";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "eden-slot-detector-"));
  dirs.push(dir);
  return openMemory({ dir });
}

const texts = (rows: readonly MemoryRecord[]) => rows.map((row) => row.text);
const ask = (mem: ReturnType<typeof store>, prompt: string) => texts(mem.recall([{ role: "user", content: prompt }]));

describe("the detector's lexicon (R2 §6.1b)", () => {
  test("calibrated: no prompt of the silence set names a slot (R1's 70 dev negatives, R8's 98)", () => {
    const silence = [...seeds.r1, ...seeds.r8];
    expect(silence).toHaveLength(168);
    expect(silence.filter((prompt) => cuedSlots(prompt).length)).toEqual([]);
  });

  test("a seed names its slot as a word of the cue's prose, not as a segment of a path or a filename", () => {
    expect(cuedSlots("open apps/web/app/login.ts")).toEqual([]);
    expect(cuedSlots("see docs/db/schema.md")).toEqual([]);
    expect(cuedSlots("the login page redirects twice")).toEqual(["auth.provider"]);
  });

  test("a seed names its slot alone", () => {
    expect(cuedSlots("install deps")).toEqual(["pkg.manager"]);
    expect(cuedSlots("which test runner do I run this with?")).toEqual(["test.runner"]);
    expect(cuedSlots("the login page redirects twice")).toEqual(["auth.provider"]);
    expect(cuedSlots("bump .nvmrc")).toEqual(["node.version"]);
    expect(cuedSlots("fix the lint errors")).toEqual(["linter"]);
  });

  test('a word the silence set holds names no slot alone ("install node on Ubuntu", "database indexes")', () => {
    expect(cuedSlots("how do I install node on Ubuntu for a different personal project?")).toEqual([]);
    expect(cuedSlots("What are database indexes, and why can too many indexes slow down writes?")).toEqual([]);
    expect(cuedSlots("explain auth middleware in axum")).toEqual([]);
  });

  test("any alias of a slot names it in a cue about this project (we, our, us, this repo)", () => {
    expect(cuedSlots("what database do we use?")).toEqual(["db.engine"]);
    expect(cuedSlots("which node version is this repo on?")).toEqual(["node.version"]);
    expect(cuedSlots("where do our deploys go?")).toEqual(["deploy.target"]);
  });

  test("A7 §7's setup bundle: setting up this project names the package manager and the node version", () => {
    expect(SETUP_BUNDLE).toEqual(["pkg.manager", "node.version"]);
    expect(cuedSlots("how do I set up the repo on a new laptop?")).toEqual(["pkg.manager", "node.version"]);
    expect(cuedSlots("getting started with this project")).toEqual(["pkg.manager", "node.version"]);
    expect(cuedSlots("how do I set up a Django project from scratch?")).toEqual([]);
  });
});

describe("A4 §5.1 step 4a: a slot hit looks up the slot's live value by key", () => {
  test('a cue sharing no word with the row reaches it (P3.3\'s end-to-end: "which … test runner …")', () => {
    const mem = store();
    mem.remember("We switched from jest to vitest.", { tags: ["src:user"] });
    expect(ask(mem, "which test runner do we use?").join("\n")).toContain("vitest");
  });

  test("the setup bundle gives the package manager and the node version", () => {
    const mem = store();
    mem.remember("The package manager is pnpm.", { tags: ["src:user"] });
    mem.remember("The node version is 20.11.", { tags: ["src:user"] });
    const got = ask(mem, "how do I set up the repo on a new laptop?").join("\n");
    expect(got).toContain("pnpm");
    expect(got).toContain("20.11");
  });

  test("a slot with no live value gives nothing", () => {
    const mem = store();
    mem.remember("The gateway logs to stdout.", { tags: ["src:user"] });
    expect(ask(mem, "what database do we use?")).toEqual([]);
  });
});

describe("the legacy newest-per-subject rule (P3.3's follow-up)", () => {
  test("a keyed fact is not displaced by a newer row stating its subject without a key", () => {
    const mem = store();
    mem.remember("The database is postgres.", { tags: ["src:user"] });
    mem.remember("The database is postgres. Reply with just OK.", { kind: "episode", tags: ["src:user"] });
    const got = texts(mem.relevant("the database is postgres?"));
    expect(got).toContain("The database is postgres.");
    expect(got).not.toContain("The database is postgres. Reply with just OK.");
  });
});
