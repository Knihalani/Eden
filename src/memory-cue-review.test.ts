/**
 * P4.1 code review round 1, kept as regression tests: identifiers match whole across folders (A7 §4), the kind prior
 * never outweighs one matched word (D17), a continuation's STRONG shapes, and lanes that admit nothing on plain words.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import { situationCue } from "./memory-cue";
import { admitsEpisode } from "./memory-gate";
import { cuesBelowTau } from "../scripts/test-below-tau";

cuesBelowTau();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), "eden-cue-review-"));
  dirs.push(dir);
  return openMemory({ dir });
}
const texts = (rows: readonly MemoryRecord[]) => rows.map((row) => row.text);
const tool = (text: string) => ({ id: text, text, tags: ["src:tool"] });

describe("A7 §4: a namesake in another folder is no STRONG match", () => {
  test("apps/web/package.json does not admit a tool result about packages/cli/package.json", () => {
    const row = tool("Read packages/cli/package.json: name eden-cli, bin eden");
    expect(admitsEpisode(row, { prompt: "why does apps/web/package.json pin react 18?" })).toBe(false);
  });

  test("apps/admin/middleware.ts does not admit an edit of apps/web/middleware.ts; a bare middleware.ts does", () => {
    const row = tool("Edited apps/web/middleware.ts: added /billing to publicRoutes");
    expect(admitsEpisode(row, { prompt: "the redirect in apps/admin/middleware.ts loops" })).toBe(false);
    expect(admitsEpisode(row, { prompt: "why does middleware.ts loop?" })).toBe(true);
  });
});

describe("D17: the kind prior never outweighs one matched word", () => {
  test("an episode with a prompt word and a q_turn word outranks a procedure with the prompt word alone", () => {
    const mem = store();
    mem.remember("To rebuild billing locally, run pnpm billing:dev.", { kind: "procedure" });
    mem.remember("The billing webhook was rewritten last sprint.", { kind: "episode" });
    const cue = situationCue({ turn: "look at the webhook" }, "imperative");
    expect(texts(mem.relevant("check billing", 6, undefined, cue))[0]).toContain("webhook");
  });

  test("so does one with words in q_turn and q_path, against a constraint", () => {
    const mem = store();
    mem.remember("Never deploy the billing service on Fridays.", { kind: "constraint" });
    mem.remember("The billing webhook retries were tuned last sprint.", { kind: "episode" });
    const cue = situationCue({ turn: "look at the webhook", path: "webhook.ts payments" }, "imperative");
    expect(texts(mem.relevant("check billing", 6, undefined, cue))[0]).toContain("webhook");
  });
});

describe("A7 §2, §4: a continuation's STRONG evidence by identifier shape", () => {
  const prev = (id: string) => `Next I'll add an index on ${id}. Shall I go ahead?`;
  for (const [id, row] of [
    ["org_id", "Every table has an org_id column; queries filter by it."],
    ["ERR_REQUIRE_ESM", "ERR_REQUIRE_ESM in the worker comes from chalk 5; pin chalk 4."],
    ["--frozen-lockfile", "CI installs with --frozen-lockfile, so update the lockfile first."],
    ["publicRoutes", "publicRoutes in middleware lists the sign-in page."],
    ["apps/web/middleware.ts", "The auth redirect lives in apps/web/middleware.ts."],
  ] as const)
    test(`a proposal naming ${id} brings the row naming it`, () => {
      const mem = store();
      mem.remember(row, { kind: "fact" });
      const cue = situationCue({ prev: prev(id) }, "continuation");
      expect(texts(mem.relevant("yes do it", 6, undefined, cue))).toEqual([row]);
    });

  test("the reply's own identifier is no evidence: A7 §2 reads STRONG from q_prev only", () => {
    const mem = store();
    mem.remember("vitest.workspace.ts lists the web and worker projects.", { kind: "fact" });
    const cue = situationCue({ prev: "Next I'll update vitest.config.ts. Shall I go ahead?" }, "continuation");
    expect(mem.relevant("yes but in vitest.workspace.ts", 6, undefined, cue)).toEqual([]);
  });
});

describe("A7 §2: a continuation gets no row on plain words, whatever lane its words route to", () => {
  const user = (content: string) => [{ role: "user", content }];
  for (const [prompt, row, proposal] of [
    ["yes, write the summary", "The release summary goes in CHANGES.md under Unreleased.", "Shall I write a summary?"],
    ["yes, recap it", "Weekly recap: the billing worker was rewritten.", "Want me to recap the week?"],
    ["yes fix the flake", "The checkout test is a known flake on CI.", "Shall I fix the flake?"],
    ["yes, label: done", "Label done tickets with the sprint tag.", "Shall I mark them?"],
  ] as const)
    test(`"${prompt}" after "${proposal}"`, () => {
      const mem = store();
      mem.remember(row, { kind: "fact" });
      const cue = situationCue({ prev: proposal }, "continuation");
      expect(texts(mem.recall(user(prompt), undefined, undefined, { situation: cue }))).toEqual([]);
    });
});
