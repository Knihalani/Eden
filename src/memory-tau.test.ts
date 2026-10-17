/**
 * P4.3: τ_repo (A7 §4, D17; `memory-tau.ts`): R1's strict point rescaled by the store's mean idf until a refit is
 * trusted; the refit at heavy sleep on the silence set (seed hard negatives, the repo's logged prompts, `ack`s, the
 * user's other repos' prompts); the silence log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";
import {
  FIXTURE_MEAN_IDF,
  FIXTURE_TAU,
  logSilence,
  meanIdf,
  R1_NORM,
  readSilence,
  readTau,
  SEED_NEGATIVES,
  SILENCE_FILE,
  silentNorm,
  tauOf,
  TRUSTED_SILENCE,
  trimSilence,
  writeTau,
  type TauRecord,
} from "./memory-tau";
import { sleep } from "./sleep";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-tau-"));
  dirs.push(dir);
  return dir;
}

const record = (norm: number): TauRecord => ({
  v: 1,
  norm,
  source: "fit",
  n: 300,
  strong: 0,
  meanIdf: 1,
  scores: [],
  logged: 0,
  at: 0,
});

describe("τ_repo's scale", () => {
  test("mean idf is the mean of each distinct term's idf (R1's formula, never negative)", () => {
    expect(meanIdf(10, [1, 1])).toBeCloseTo(Math.log(1 + 9.5 / 1.5), 12);
    expect(meanIdf(10, [1, 10])).toBeCloseTo((Math.log(1 + 9.5 / 1.5) + Math.log(1 + 0.5 / 10.5)) / 2, 12);
    expect(meanIdf(0, [])).toBe(0);
  });

  test("R1's strict point, 4.1 on the fixture's scale, rescaled by the store's mean idf", () => {
    expect(FIXTURE_TAU).toBe(4.1);
    expect(R1_NORM).toBeCloseTo(4.1 / FIXTURE_MEAN_IDF, 12);
    const dir = tempDir();
    expect(tauOf(dir, FIXTURE_MEAN_IDF)).toBeCloseTo(4.1, 12);
    expect(tauOf(dir, 2 * FIXTURE_MEAN_IDF)).toBeCloseTo(8.2, 12);
  });

  test("a refit's threshold replaces R1's; EDEN_MEMORY_TAU overrides both (0 included); garbage is ignored", () => {
    const dir = tempDir();
    writeTau(dir, record(0.5));
    expect(tauOf(dir, 3, undefined)).toBeCloseTo(1.5, 12);
    expect(tauOf(dir, 3, "0")).toBe(0);
    expect(tauOf(dir, 3, "2")).toBe(6);
    expect(tauOf(dir, 3, "loud")).toBeCloseTo(1.5, 12);
    expect(tauOf(dir, 3, "-1")).toBeCloseTo(1.5, 12);
    writeFileSync(join(dir, "tau.json"), "{not json");
    expect(tauOf(dir, 3, undefined)).toBeCloseTo(3 * R1_NORM, 12);
  });

  test("the smallest threshold that keeps every score silent is just above the highest", () => {
    const norm = silentNorm([0.2, 0.9, 0.4])!;
    expect(norm).toBeGreaterThan(0.9);
    expect(norm).toBeLessThan(0.9 + 1e-6);
    expect(silentNorm([0, 0])).toBeUndefined();
  });
});

describe("the silence log (A7 §4: logged human prompts with no evidence, and acks)", () => {
  test("an ack by its kind alone, a prompt by its turn's prompt_id, never its text; read back newest last", () => {
    const dir = tempDir();
    logSilence(dir, "ack", "turn-1", 1);
    logSilence(dir, "empty", "turn-2", 2);
    logSilence(dir, "empty", undefined, 3);
    expect(readFileSync(join(dir, SILENCE_FILE), "utf8")).not.toContain("turn-1");
    expect(readSilence(dir)).toEqual({ acks: 1, empty: ["turn-2"] });
  });

  test("the refit keeps the newest 2,000 lines", () => {
    const dir = tempDir();
    const lines = Array.from({ length: 2_100 }, (_, i) => JSON.stringify({ k: "empty", p: `h${i}`, t: i }));
    writeFileSync(join(dir, SILENCE_FILE), `${lines.join("\n")}\n`);
    trimSilence(dir);
    const kept = readSilence(dir).empty;
    expect(kept).toHaveLength(2_000);
    expect(kept[0]).toBe("h100");
    expect(kept.at(-1)).toBe("h2099");
  });
});

/** A store of a few facts that share words with nothing in the seeds but one: the seed "write a python function". */
function seeded(dir: string, perRepo = false) {
  const mem = openMemory(perRepo ? { dir, perRepo: true } : { dir });
  mem.quiet(() => {
    for (let i = 0; i < 30; i++)
      mem.remember(`Gadget ${i} stores its q${i}x values in the w${i}a table.`, { kind: "fact" });
    mem.remember("Every python function in tools/ is typed with mypy strict.", { kind: "fact" });
  });
  mem.refreshPostings();
  return mem;
}

describe("τ_repo's refit (heavy sleep)", () => {
  test("seeds alone are fewer than 300 prompts: the fit is recorded, R1's point is used", () => {
    const dir = tempDir();
    const mem = seeded(dir);
    const rec = mem.refitTau()!;
    expect(rec.source).toBe("r1");
    expect(rec.norm).toBe(R1_NORM);
    expect(rec.n).toBe(SEED_NEGATIVES.length);
    expect(SEED_NEGATIVES.length).toBe(70 + 98);
    expect(rec.fit).toBeGreaterThan(0);
    expect(readTau(dir)).toEqual(rec);
  });

  test("300 prompts with the logged ones: the fit is trusted and τ is the smallest that keeps them silent", () => {
    const dir = tempDir();
    const mem = seeded(dir);
    const logged = Array.from({ length: TRUSTED_SILENCE - SEED_NEGATIVES.length }, (_, i) => `what is ${i} squared`);
    logged.forEach((prompt, i) => {
      mem.remember(prompt, { kind: "episode", origin: { promptId: `turn-${i}` } });
      logSilence(dir, "empty", `turn-${i}`, 1);
    });
    const rec = mem.refitTau()!;
    expect(rec.n).toBe(TRUSTED_SILENCE);
    expect(rec.logged).toBe(logged.length);
    expect(rec.source).toBe("fit");
    expect(rec.norm).toBe(rec.fit!);
    // Every seed and logged prompt stays silent at the refit's τ.
    for (const prompt of [...SEED_NEGATIVES, ...logged]) {
      mem.relevant(prompt);
      expect(mem.lastGate!.medium).toBe(0);
    }
  });

  test("a logged prompt is replayed without its turn's rows; one no row stores is left out", () => {
    const dir = tempDir();
    const mem = seeded(dir);
    mem.remember("zebrafish aquarium temperature tuning", { kind: "episode", origin: { promptId: "turn-1" } });
    logSilence(dir, "empty", "turn-1", 1);
    logSilence(dir, "empty", "turn-2", 2);
    logSilence(dir, "ack", "turn-3", 3);
    const rec = mem.refitTau()!;
    expect(rec.logged).toBe(2);
    expect(rec.scores).toEqual([0]);
  });

  test("the user's other repos pool their logged prompts' scores and counts", () => {
    const root = tempDir();
    const a = join(root, "repos", "a");
    const b = join(root, "repos", "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeTau(b, { ...record(0.3), scores: [0.01], logged: TRUSTED_SILENCE });
    const rec = seeded(a, true).refitTau()!;
    expect(rec.n).toBe(SEED_NEGATIVES.length + TRUSTED_SILENCE);
    expect(rec.source).toBe("fit");
  });

  test("the full sleep refits τ after writing the postings snapshot", async () => {
    const dir = tempDir();
    const mem = seeded(dir);
    await sleep({ dir, mem });
    expect(existsSync(join(dir, "tau.json"))).toBe(true);
    expect(readTau(dir)!.source).toBe("r1");
  });
});
