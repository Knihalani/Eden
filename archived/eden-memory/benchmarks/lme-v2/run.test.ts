/**
 * M26.1 runner honesty. Does not call NIM. Does not write RESULTS.md.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPERIENCE_BYTES_ENV, ExperienceStore } from "../../src/experience-store.ts";
import {
  DATASET_FILENAMES,
  LME_EXPERIENCE_BYTES,
  LmeDatasetMissingError,
  OFFICIAL_N,
  RESULTS_PATH,
  RESULTS_SMOKE_PATH,
  ensureExperienceBudget,
  ingestDomain,
  isOfficialRun,
  requireDatasetFile,
  resultsPathFor,
  shouldWriteLastRun,
  type CompactTraj,
} from "./run.ts";

const AX = "RootWebArea UNIQUE_M26_AX_TREE [landmark]";
const GOLD_GOAL = "UNIQUE_M26_GOLD_GOAL";
const GOLD_OUTCOME = "UNIQUE_M26_GOLD_OUTCOME";

function tmp(prefix = "eden-m261-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function fileHay(dir: string, pred: (p: string) => boolean): string {
  return walk(dir)
    .filter(pred)
    .map((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

function sampleTraj(id = "m26-test-traj"): CompactTraj {
  return {
    id,
    domain: "web",
    environment: "test",
    goal: GOLD_GOAL,
    outcome: GOLD_OUTCOME,
    start_url: "https://example.com/m26",
    n_states_raw: 1,
    n_states_kept: 1,
    chars_raw_est: 80,
    chars_kept: 80,
    states: [
      {
        url: "https://example.com/m26",
        action: "click #go",
        thought: "look for the widget",
        observation: AX,
      },
    ],
  };
}

describe("M26.1 smoke ≠ official", () => {
  test("n=451 without LME_LIMIT is official; LME_LIMIT or n<451 is smoke", () => {
    expect(OFFICIAL_N).toBe(451);
    expect(isOfficialRun(451, undefined)).toBe(true);
    expect(isOfficialRun(451, "")).toBe(true);
    expect(isOfficialRun(451, "10")).toBe(false);
    expect(isOfficialRun(451, "451")).toBe(false);
    expect(isOfficialRun(200, undefined)).toBe(false);
    expect(isOfficialRun(0, undefined)).toBe(false);
    expect(resultsPathFor(451, undefined)).toBe(RESULTS_PATH);
    expect(resultsPathFor(10, undefined)).toBe(RESULTS_SMOKE_PATH);
    expect(resultsPathFor(451, "5")).toBe(RESULTS_SMOKE_PATH);
    expect(shouldWriteLastRun(451, undefined)).toBe(true);
    expect(shouldWriteLastRun(10, undefined)).toBe(false);
    expect(shouldWriteLastRun(451, "1")).toBe(false);
    expect(RESULTS_SMOKE_PATH).not.toBe(RESULTS_PATH);
    expect(RESULTS_SMOKE_PATH.endsWith("RESULTS.smoke.md")).toBe(true);
  });
});

describe("M26.1 named dataset miss", () => {
  test("requireDatasetFile throws LmeDatasetMissingError with exact filename", () => {
    const missing = join(tmp(), "nope.jsonl");
    try {
      requireDatasetFile(missing, DATASET_FILENAMES.questions);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LmeDatasetMissingError);
      const e = err as LmeDatasetMissingError;
      expect(e.name).toBe("LmeDatasetMissingError");
      expect(e.filename).toBe("questions.jsonl");
      expect(e.message).toBe("Blocked: LME dataset missing: questions.jsonl");
    }
  });

  test("present file does not throw; haystack and traj names are exact", () => {
    const dir = tmp();
    const p = join(dir, "questions.jsonl");
    writeFileSync(p, "{}\n");
    requireDatasetFile(p, DATASET_FILENAMES.questions);
    expect(DATASET_FILENAMES.haystack).toBe("haystacks/lme_v2_small.json");
    expect(DATASET_FILENAMES.trajFull).toBe("trajectories.jsonl");
    expect(DATASET_FILENAMES.trajCompact).toBe("trajectories.small-compact.jsonl");
  });
});

describe("M26.1 ingest writes experience files, not AX JSONL", () => {
  test("putExperience stores AX tree; sleep leaves files; chat JSONL omits AX", async () => {
    const dir = tmp("eden-m261-ingest-");
    const prev = process.env[EXPERIENCE_BYTES_ENV];
    try {
      const ing = await ingestDomain(dir, [sampleTraj()]);
      expect(ing.experience_files).toBe(1);
      expect(ing.experience_bytes_cap).toBe(LME_EXPERIENCE_BYTES);
      const store = new ExperienceStore(dir);
      const ids = store.ids();
      expect(ids.length).toBe(1);
      const traj = store.get("m26-test-traj");
      expect(traj).not.toBeNull();
      expect(traj?.goal).toContain(GOLD_GOAL);
      expect(traj?.outcome).toContain(GOLD_OUTCOME);
      const tree = traj?.states.map((s) => s.tree || "").join("\n") || "";
      expect(tree).toContain("UNIQUE_M26_AX_TREE");
      expect(tree).toContain("RootWebArea");
      const jsonl = fileHay(dir, (p) => p.endsWith("memories.jsonl"));
      expect(jsonl).toContain(GOLD_GOAL);
      expect(jsonl).toContain(GOLD_OUTCOME);
      expect(jsonl).not.toContain("UNIQUE_M26_AX_TREE");
      expect(jsonl).not.toContain("RootWebArea");
      expect(existsSync(join(dir, "experience", "m26-test-traj.jsonl"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[EXPERIENCE_BYTES_ENV];
      else process.env[EXPERIENCE_BYTES_ENV] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensureExperienceBudget raises a tight cap and does not set JSONL store cap", () => {
    const prevExp = process.env[EXPERIENCE_BYTES_ENV];
    const prevStore = process.env.EDEN_MEMORY_STORE_CAP;
    try {
      process.env[EXPERIENCE_BYTES_ENV] = "1024";
      delete process.env.EDEN_MEMORY_STORE_CAP;
      expect(ensureExperienceBudget()).toBe(LME_EXPERIENCE_BYTES);
      expect(Number(process.env[EXPERIENCE_BYTES_ENV])).toBe(LME_EXPERIENCE_BYTES);
      expect(process.env.EDEN_MEMORY_STORE_CAP).toBeUndefined();
      process.env[EXPERIENCE_BYTES_ENV] = String(512 * 1024 * 1024);
      expect(ensureExperienceBudget()).toBe(512 * 1024 * 1024);
    } finally {
      if (prevExp === undefined) delete process.env[EXPERIENCE_BYTES_ENV];
      else process.env[EXPERIENCE_BYTES_ENV] = prevExp;
      if (prevStore === undefined) delete process.env.EDEN_MEMORY_STORE_CAP;
      else process.env.EDEN_MEMORY_STORE_CAP = prevStore;
    }
  });
});
