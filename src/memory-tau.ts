/**
 * τ_repo (A7 §4, D17): the BM25F sum a row needs before MEDIUM evidence admits it. Lexical thresholds transfer poorly
 * between corpora (R1 §3.2: dev FIR 0 became test FIR 7.5%), so τ is per repo and kept on one scale: a store's τ is
 * `norm × meanIdf`, its mean idf times a normalized threshold, so a store that grows keeps its operating point.
 *
 * - **Until it is trusted**, `norm` is R1's strict point: τ = 4.1 on the fixture's scale (`FIXTURE_TAU`), rescaled by
 *   the store's mean idf against the fixture's (`FIXTURE_MEAN_IDF`).
 * - **The refit** (heavy sleep, `AgentMemory.refitTau`): the silence set is replayed against the store, and `norm` is
 *   the smallest that keeps it silent: above every prompt's top MEDIUM-path score, each divided by the mean idf of the
 *   store it was scored in, so prompts of the user's other repos pool with this one's. The set is the seed hard
 *   negatives (`memory-silence-seeds.json`: R1's dev negatives and R8's 98), the repo's logged human prompts on which
 *   no row had MEDIUM evidence, and the prompts in `ack` mode (`silence.jsonl`). It is trusted from
 *   `TRUSTED_SILENCE` prompts on; until then the fit is recorded and R1's point is used.
 *
 * `tau.json` beside the store holds the last refit; `silence.jsonl` holds the logged prompts by their turn's
 * `prompt_id`, never their text: a prompt is replayed from the row its turn stored (`AgentMemory.refitTau`).
 */
import { appendFileSync, chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import seeds from "./memory-silence-seeds.json";

export const TAU_FILE = "tau.json";
export const SILENCE_FILE = "silence.jsonl";
/** R1's strict point (R1 §3.2: BM25F_ctx, dev FIR 0): the τ of the fixture's scale. */
export const FIXTURE_TAU = 4.1;
/**
 * The mean idf of the R1 fixture's live memories as the postings index them (`meanIdf`): its 205 live memories
 * remembered into one store index as 182 rows (rule rows are delivered by their classes, D18), mean idf 4.5466.
 */
export const FIXTURE_MEAN_IDF = 4.55;
/** A7 §4: never fewer prompts, pooled across the user's repos, before a refit's τ is trusted. */
export const TRUSTED_SILENCE = 300;
/** The logged prompts a repo keeps: the newest. */
const SILENCE_KEPT = 2_000;
/** D17's relative cut: a row the MEDIUM path admits scores at least this share of the top. */
export const RELATIVE_CUT = 0.7;

/** The seed hard negatives (A7 §4): R1's dev negatives (chat, math, off-topic, hard lexical traps) and R8's 98. */
export const SEED_NEGATIVES: readonly string[] = [...seeds.r1, ...seeds.r8];

/** R1's normalized threshold: the strict point over the fixture's mean idf. */
export const R1_NORM = FIXTURE_TAU / FIXTURE_MEAN_IDF;

/** The mean idf of a corpus's distinct terms, given each term's df and the number of rows (`idf`'s formula). */
export function meanIdf(n: number, dfs: Iterable<number>): number {
  let sum = 0;
  let terms = 0;
  for (const df of dfs) {
    const d = Math.min(df, n);
    sum += Math.log(1 + (n - d + 0.5) / (d + 0.5));
    terms++;
  }
  return terms ? sum / terms : 0;
}

/** The last refit of a store (see the header). */
export interface TauRecord {
  v: 1;
  /** The normalized threshold in use: the fit's when trusted, else R1's. */
  norm: number;
  /** Where `norm` came from. */
  source: "fit" | "r1";
  /** The fit's own normalized threshold, trusted or not; undefined when no prompt scored above 0. */
  fit?: number;
  /** The silence set's size, pooled: seeds, every repo's logged prompts. */
  n: number;
  /** The seeds and logged prompts τ cannot silence: a STRONG identifier admits a row on them whatever τ is. */
  strong: number;
  /** The store's mean idf at the refit. */
  meanIdf: number;
  /** This repo's logged prompts' normalized top scores, which the user's other repos pool with theirs. */
  scores: number[];
  /** How many of this repo's logged prompts the refit counted: replayed ones and `ack`s. */
  logged: number;
  at: number;
}

export function readTau(dir: string): TauRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(dir, TAU_FILE), "utf8")) as TauRecord;
    return rec?.v === 1 && Number.isFinite(rec.norm) && rec.norm > 0 ? rec : undefined;
  } catch {
    return undefined;
  }
}

export function writeTau(dir: string, rec: TauRecord): void {
  const path = join(dir, TAU_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/**
 * A store's τ: its refit's normalized threshold (R1's until one is trusted) times its mean idf now. `EDEN_MEMORY_TAU`,
 * a normalized threshold of 0 or more, overrides the refit (a quieter or louder store for one user; tests of other
 * behaviour on stores of a few rows, where a cue of one word stays below τ).
 */
export function tauOf(dir: string, storeMeanIdf: number, env = process.env.EDEN_MEMORY_TAU): number {
  const forced = env === undefined || env.trim() === "" ? Number.NaN : Number(env);
  const norm = Number.isFinite(forced) && forced >= 0 ? forced : (readTau(dir)?.norm ?? R1_NORM);
  return norm * storeMeanIdf;
}

/**
 * The smallest normalized threshold that keeps every score silent: just above the highest (a row is admitted at
 * `score ≥ τ`). Undefined when no prompt reached a row.
 */
export function silentNorm(scores: readonly number[]): number | undefined {
  const top = scores.reduce((max, score) => Math.max(max, score), 0);
  return top > 0 ? top * (1 + 1e-9) : undefined;
}

/** What a logged silence prompt was: one in `ack` mode, or one no row had MEDIUM evidence for. */
export type SilenceKind = "ack" | "empty";

/**
 * Logs a human prompt to the repo's silence set (see the header) by its turn's `prompt_id`, the id the rows it stored
 * carry: an `ack` by its kind alone, as no row stores it and it matches nothing. Fails open.
 */
export function logSilence(dir: string, kind: SilenceKind, promptId: string | undefined, at: number): void {
  try {
    const line = kind === "ack" || !promptId ? { k: kind, t: at } : { k: kind, p: promptId, t: at };
    appendFileSync(join(dir, SILENCE_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {}
}

export interface SilenceLog {
  /** How many prompts were logged in `ack` mode. */
  acks: number;
  /** The `prompt_id`s of the logged prompts no row had evidence for, oldest first. */
  empty: string[];
}

/** Keeps the newest `SILENCE_KEPT` lines of the repo's silence log (the refit's). Fails open. */
export function trimSilence(dir: string): void {
  const path = join(dir, SILENCE_FILE);
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= SILENCE_KEPT) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${lines.slice(-SILENCE_KEPT).join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {}
}

/** The repo's logged silence prompts, the newest `SILENCE_KEPT`. */
export function readSilence(dir: string): SilenceLog {
  const log: SilenceLog = { acks: 0, empty: [] };
  let lines: string[];
  try {
    lines = readFileSync(join(dir, SILENCE_FILE), "utf8").split("\n").filter(Boolean).slice(-SILENCE_KEPT);
  } catch {
    return log;
  }
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as { k?: string; p?: unknown };
      if (rec.k === "ack") log.acks++;
      else if (rec.k === "empty" && typeof rec.p === "string") log.empty.push(rec.p);
    } catch {}
  }
  return log;
}
