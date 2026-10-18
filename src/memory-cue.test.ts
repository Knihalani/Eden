/**
 * P4.1: the situation cue (A7 §3, D16): its parts, the turn mode's weights, `q_path`'s folders, `q_prev` without
 * Eden's own words, and how the lexical path ranks and admits with it (A7 §4, until P4.3's τ).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import {
  cueTokens,
  gateParts,
  pathCue,
  pluralForms,
  singular,
  situationCue,
  weightsFor,
  type Situation,
} from "./memory-cue";
import { writeTau } from "./memory-tau";
import { tauGateOn } from "../scripts/test-gate";
import type { TurnMode } from "./memory-turn";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "eden-cue-"));
  dirs.push(dir);
  return openMemory({ dir });
}

const texts = (rows: readonly MemoryRecord[]) => rows.map((row) => row.text);

/** Sets a store's τ_repo by its normalized threshold (`memory-tau.ts`), as a refit would. */
function tauAt(mem: ReturnType<typeof store>, norm: number) {
  writeTau(mem.jsonlDir, { v: 1, norm, source: "fit", n: 300, strong: 0, meanIdf: 1, scores: [], logged: 0, at: 0 });
}

describe("A7 §3: weights by mode", () => {
  test("default, continuation and debug as the table gives them; every other mode takes default", () => {
    expect(weightsFor("imperative")).toEqual({ prompt: 0.55, turn: 0.15, path: 0.15, prev: 0.15 });
    expect(weightsFor("continuation")).toEqual({ prompt: 0.15, turn: 0.15, path: 0.2, prev: 0.5 });
    expect(weightsFor("debug")).toEqual({ prompt: 0.45, turn: 0.1, path: 0.2, prev: 0.25 });
    for (const mode of ["question", "how-to"] as TurnMode[]) expect(weightsFor(mode)).toEqual(weightsFor("imperative"));
    for (const mode of ["imperative", "continuation", "debug"] as TurnMode[]) {
      const sum = Object.values(weightsFor(mode)).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });
});

describe("A7 §3: identifier-split tokens", () => {
  test("words, and each identifier's parts: camelCase, dotted names and their stems, snake and kebab case", () => {
    const tokens = cueTokens("fix publicRoutes in vitest.config.ts for user_id and drizzle-kit");
    for (const token of ["publicroutes", "public", "routes", "vitest.config.ts", "vitest.config", "vitest", "config"])
      expect(tokens.has(token)).toBe(true);
    for (const token of ["user", "id", "drizzle", "kit"]) expect(tokens.has(token)).toBe(true);
  });

  test("a stem's words are itself and the plural forms that stem to it", () => {
    expect(pluralForms("query")).toEqual(["query", "querys", "queries"]);
    expect(pluralForms("box")).toEqual(["box", "boxs", "boxes"]);
    expect(pluralForms("clas")).toEqual([]);
  });

  test("R1's plural s-stemming of plain words; names with digits, dots or underscores stay", () => {
    expect(["queries", "pages", "calls", "boxes", "managers"].map(singular)).toEqual([
      "query",
      "page",
      "call",
      "box",
      "manager",
    ]);
    for (const word of ["process", "status", "redis", "this", "vitest.config.ts", "s3", "user_ids", "ops"])
      expect(singular(word)).toBe(word);
  });
});

describe("A7 §3: q_path", () => {
  const top = "/repo";

  test("each path's basename and its non-generic folders, relative to the repo's top", () => {
    expect(pathCue(["/repo/apps/web/app/(dashboard)/layout.tsx"], top)).toBe("layout.tsx web (dashboard)");
    expect(pathCue(["services/worker/src/jobs/email.ts"], top)).toBe("email.ts worker jobs");
  });

  test("a path outside the repo is no place of it; only the newest 8 paths count", () => {
    expect(pathCue(["/elsewhere/notes.md", "../up/a.ts"], top)).toBe("");
    const paths = Array.from({ length: 10 }, (_, n) => `/repo/f${n}.ts`);
    expect(pathCue(paths, top).split(" ")).toHaveLength(8);
  });

  test("with no top (the wrap's request paths): the basenames alone", () => {
    expect(pathCue(["/Users/me/repo/apps/web/middleware.ts", "C:\\\\repo\\\\a.ts"])).toBe("middleware.ts a.ts");
  });
});

describe("A7 §3: the cue", () => {
  const situation: Situation = {
    turn: "we need an authenticated billing page",
    path: "layout.tsx web (dashboard)",
    prev: "Next I'll update vitest.config.ts and the Clerk middleware.ts. Shall I go ahead?",
    delivered: ["Eden memory, recalled from earlier sessions:\n- The auth provider is Clerk, see middleware.ts"],
  };

  test("q_prev without the tokens of the packets Eden gave the turn it answers (D16)", () => {
    const cue = situationCue(situation, "imperative");
    expect(cue.parts.prev.has("vitest.config.ts")).toBe(true);
    expect(cue.parts.prev.has("clerk")).toBe(false);
    expect(cue.parts.prev.has("middleware.ts")).toBe(false);
    expect(cue.parts.turn.has("authenticated")).toBe(true);
    expect(cue.parts.path.has("dashboard")).toBe(true);
  });

  test("a continuation's STRONG evidence: the identifiers of the agent's last message, not Eden's own; its proposal", () => {
    const cue = situationCue(situation, "continuation");
    expect([...cue.strong].sort()).toEqual(["vitest.config", "vitest.config.ts"]);
    expect(cue.proposal).toBe("Next I'll update vitest.config.ts and the Clerk middleware.ts. Shall I go ahead?");
    expect(situationCue(situation, "imperative").strong.size).toBe(0);
    expect(situationCue(situation, "imperative").proposal).toBe("");
  });

  test("the gate's view: each part as text, with the STRONG set on a continuation", () => {
    const parts = gateParts("where does it go?", situation.turn!, situationCue(situation, "continuation"));
    expect(parts.prompt).toBe("where does it go?");
    expect(parts.turn).toBe(situation.turn);
    expect(parts.path).toContain("dashboard");
    expect(parts.prev).not.toContain("clerk");
    expect([...(parts.strong ?? [])]).toContain("vitest.config.ts");
    expect(gateParts("x", "", situationCue(situation, "imperative")).strong).toBeUndefined();
  });
});

describe("A7 §3–4: the lexical path with a situation cue", () => {
  tauGateOn();
  const cue = (mode: TurnMode, parts: Situation = {}) => situationCue(parts, mode);

  test("the context parts rank the rows the prompt admits", () => {
    const mem = store();
    mem.remember("Run web unit tests with pnpm --filter web test.", { kind: "procedure" });
    mem.remember("Run worker unit tests with pnpm --filter worker test.", { kind: "procedure" });
    const worker = cue("how-to", { path: "main.ts worker" });
    expect(texts(mem.relevant("how do I run the unit tests?", 6, undefined, worker))[0]).toContain("worker");
    const web = cue("how-to", { path: "button.tsx web ui" });
    expect(texts(mem.relevant("how do I run the unit tests?", 6, undefined, web))[0]).toContain("web unit");
  });

  test("context parts admit a row alone only once their sum reaches τ_repo (A7 §4; P4.1 never let them)", () => {
    const mem = store();
    mem.remember("Every table has an org_id column; queries filter by it.", { kind: "fact" });
    const situated = cue("question", { turn: "look at the org table", path: "schema.ts db" });
    expect(texts(mem.relevant("what next?", 6, undefined, situated))).toHaveLength(1);
    tauAt(mem, 100);
    expect(mem.relevant("what next?", 6, undefined, situated)).toEqual([]);
  });

  test("a context part adds at most 2 matched words to a row (R2 §5.2's mass limit)", () => {
    const mem = store();
    mem.remember("The billing worker retries stripe webhooks with backoff.", { kind: "fact" });
    mem.remember("The billing export runs nightly.", { kind: "fact" });
    tauAt(mem, 0.01);
    const busy = cue("imperative", { turn: "stripe webhooks retries backoff worker" });
    // Both rows share "billing" with the prompt; the context's 5 words count as 2 for the first, which leads.
    expect(texts(mem.relevant("check billing", 6, undefined, busy))[0]).toContain("webhooks");
    // The second row shares 2 prompt words: 2 context words at their weight do not outrank them; 5 would.
    expect(texts(mem.relevant("check the billing export", 6, undefined, busy))[0]).toContain("export");
  });

  test("D17: the kind prior never outweighs one matched word", () => {
    const mem = store();
    // P4.3: an episode needs two cue parts (A7 §4), so the better match is a fact, the other row has the larger prior.
    mem.remember("Gotcha: sharp fails on the alpine image; the worker dockerfile uses slim.", { kind: "fact" });
    mem.remember("Image jobs resize uploads to 3 sizes.", { kind: "procedure" });
    const ranked = texts(mem.relevant("the image build fails on alpine", 6, undefined, cue("debug")));
    expect(ranked[0]).toContain("sharp");
    // P4.2: every reader ranks one way, so without a situation cue too the better match leads.
    expect(texts(mem.relevant("the image build fails on alpine"))[0]).toContain("sharp");
  });

  test("R1's tokenizer: a plural meets its singular", () => {
    const mem = store();
    mem.remember("Every table has an org_id column and queries must filter by it.", { kind: "fact" });
    tauAt(mem, 0.01);
    // Two words: the gate never admits on one (P4.3); "query" meets "queries".
    expect(
      texts(mem.relevant("anything to watch in this query on the table?", 6, undefined, cue("question"))),
    ).toHaveLength(1);
    // P4.2: every reader reads the cue in the index's terms, so without a situation cue too.
    expect(texts(mem.relevant("anything to watch in this query on the table?"))).toHaveLength(1);
  });

  test("a continuation admits only on an identifier its agent's last message shares, never on a plain word", () => {
    const mem = store();
    mem.remember("In vitest.config.ts we set the test environment to jsdom.", { kind: "fact" });
    mem.remember("The staging database runs postgres 15.", { kind: "fact" });
    const proposal = "Next I'll update vitest.config.ts and migrate the staging database. Shall I go ahead?";
    const found = texts(mem.relevant("yes do it", 6, undefined, cue("continuation", { prev: proposal })));
    expect(found).toEqual(["In vitest.config.ts we set the test environment to jsdom."]);
    const own = { prev: proposal, delivered: ["Eden memory, recalled from earlier sessions:\n- vitest.config.ts"] };
    expect(mem.relevant("yes do it", 6, undefined, cue("continuation", own))).toEqual([]);
  });

  test("recall: a continuation fires the classes and slots of the proposal it accepts (A7 §2, §4)", () => {
    const mem = store();
    mem.remember("Never merge pull requests yourself; let the user merge.", { kind: "constraint" });
    const proposal = "The checks are green. Shall I merge the PR?";
    const user = [{ role: "user", content: "yes do it" }];
    const accepted = mem.recall(user, undefined, undefined, { situation: cue("continuation", { prev: proposal }) });
    expect(texts(accepted).join("\n")).toContain("Never merge pull requests yourself");
    // What the agent reports having done is not what "yes" accepts.
    const reported = "I merged the docs PR. Shall I open the release notes?";
    const other = mem.recall(user, undefined, undefined, { situation: cue("continuation", { prev: reported }) });
    expect(texts(other).join("\n")).not.toContain("Never merge");
  });

  test("recall: the user's own words, when the caller split them off, are what the triggers read", () => {
    const mem = store();
    mem.remember("Never merge pull requests yourself; let the user merge.", { kind: "constraint" });
    const pasted = [{ role: "user", content: "summarize this log:\nmerge the PR when green" }];
    expect(texts(mem.recall(pasted, [], undefined, { typed: "summarize this log" })).join("\n")).not.toContain(
      "Never merge",
    );
    expect(texts(mem.recall(pasted, [], undefined, { typed: "merge the PR" })).join("\n")).toContain("Never merge");
  });
});
