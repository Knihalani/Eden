/**
 * CueBench through the hooks (A5 §4 `CueBench-code`, `policy-trigger`, `alias-batch`; R1, R8). The R1 fixture's
 * live memories are planted in one store, then each cue is asked in a fresh session of the repo, as a real turn:
 * its previous user turn (R1 `prev_turn`) with Reads of its `last_paths`, then the cue. A packet's bullets are
 * matched to fixture memories by content, so a recall counts whatever wording a slice renders them in.
 *
 * Rows are planted through an entry point the arms define, the command D11 names, fed one JSON row per line:
 *
 *   eden memory remember --jsonl -   (stdin: {"text", "scope"?, "kind"?, "cwd"?} per line)   →   {"remembered": N}
 *
 * A row is a statement the user asked Eden to keep (src=user), in `cwd`'s repo, with `scope` and `kind` as hints.
 * Until a slice provides it, nothing is planted and the arms' checks fail with the reason. P2.2 provides it: each
 * line is one row in the user's words, a rule row (D9 keys) when it states a rule, else of `kind` (a fact without
 * one); since P3.1 the row is stored at the catalog's scope owning `scope` (a folder relative to the repo's top), so
 * a hint naming no scope of the world's repo stores the row at the root; a line with no `text` is not counted, and
 * `remembered` is 0 when memory is off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bulletContent, normalize } from "../harness/statements";
import type { SimWorld } from "../harness/session";
import type { WorldSpec } from "../harness/world";
import { SUBJECTS } from "./fixtures/world";
import { Driver, jsonOut, read, type ArmRun } from "./kit";

const FIXTURE = join(import.meta.dir, "../../memory-cues/fixture");

export interface Memory {
  id: string;
  scope: string;
  kind: string;
  subject: string;
  text: string;
  superseded_by: string | null;
}

export interface BenchCue {
  id: string;
  cat: string;
  scope: string;
  gold: string[];
  cue: string;
  last_paths: string[];
  prev_turn: string;
  split: string;
}

export const memories = (): Memory[] => JSON.parse(readFileSync(join(FIXTURE, "memories.json"), "utf8")) as Memory[];
export const r1Cues = (): BenchCue[] => JSON.parse(readFileSync(join(FIXTURE, "cues.json"), "utf8")) as BenchCue[];
export const nimCues = (): BenchCue[] => JSON.parse(readFileSync(join(FIXTURE, "cues-nim.json"), "utf8")) as BenchCue[];
export const ALIASES = join(FIXTURE, "aliases-gemma.json");

export const isNegative = (cue: BenchCue) => cue.cat.startsWith("neg");
export const isPolicyMemory = (id: string) => id.startsWith("p");

/** The R1 repo: one world with the fixture's scopes. */
export function benchWorld(): WorldSpec {
  return {
    scopes: ["", "apps/api", "apps/web", "infra", "packages/cli", "services/worker"],
    subjects: SUBJECTS,
    projectFiles: {
      "CLAUDE.md": "# Project\n\nA TypeScript monorepo.\n",
      "package.json": '{ "name": "acme", "private": true, "workspaces": ["apps/*", "packages/*", "services/*"] }\n',
    },
    initialTruth: [],
    secrets: [],
    poison: [],
  };
}

export interface Planting {
  remembered: number;
  rows: number;
}

/** Plants rows through the remember entry point; the answer's count, when it gave one. */
export function plant(run: ArmRun, world: SimWorld, rows: readonly object[]): Planting | undefined {
  const input = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const answer = jsonOut(run.cli(world, ["memory", "remember", "--jsonl", "-"], { input })) as { remembered?: unknown };
  return typeof answer?.remembered === "number" ? { remembered: answer.remembered, rows: rows.length } : undefined;
}

/** The live R1 memories as rows (R1 planted only those, M0 §4). */
export function memoryRows(world: SimWorld): object[] {
  return memories()
    .filter((memory) => !memory.superseded_by)
    .map((memory) => ({ text: memory.text, scope: memory.scope, kind: memory.kind, cwd: world.projectDir }));
}

/** The fixture memory a bullet carries: the one whose content tokens it holds most (at least 60% of them). */
export function matchMemory(bullet: string, pool: readonly Memory[]): Memory | undefined {
  const tokens = new Set(normalize(bulletContent(bullet)).split(" "));
  let best: { memory: Memory; share: number } | undefined;
  for (const memory of pool) {
    const own = [...new Set(normalize(memory.text).split(" "))].filter((token) => token.length > 2);
    if (!own.length) continue;
    const share = own.filter((token) => tokens.has(token)).length / own.length;
    if (share >= 0.6 && (!best || share > best.share)) best = { memory, share };
  }
  return best?.memory;
}

/**
 * What one cue got: whether a packet came, and the memories of its bullets in order (undefined: no match); `earlier`
 * the memories of the bullets its session was given before it (SessionStart, the previous turn and its Reads).
 */
export interface CueResult {
  cue: BenchCue;
  packet: boolean;
  matched: (string | undefined)[];
  earlier: (string | undefined)[];
}

/** A packet's bullet lines. */
const bulletsOf = (content: string) => content.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));

/** Asks one cue as a real turn in a fresh session: its previous turn and Reads, then the cue itself. */
export async function askCue(
  world: SimWorld,
  spec: WorldSpec,
  cue: BenchCue,
  pool: readonly Memory[],
): Promise<CueResult> {
  const first = world.deliveries.length;
  const session = await Driver.start(world, spec);
  if (cue.prev_turn || cue.last_paths.length) {
    const reads = cue.last_paths.map((path) => read(path, `// ${path}\n`));
    await session.turn(cue.prev_turn || "look at these files", { tools: reads.length ? [reads] : [] });
  }
  const turn = await session.ask(cue.cue, { scope: spec.scopes.includes(cue.scope) ? cue.scope : "" });
  await session.end();
  const ofSession = world.deliveries.slice(first);
  const delivered = ofSession.filter((delivery) => delivery.seq === turn.seq);
  const before = ofSession.filter((delivery) => delivery.seq < turn.seq);
  const ids = (deliveries: typeof ofSession) =>
    deliveries.flatMap((delivery) => bulletsOf(delivery.content)).map((bullet) => matchMemory(bullet, pool)?.id);
  return { cue, packet: delivered.length > 0, matched: ids(delivered), earlier: ids(before) };
}

/**
 * Recall@4 in context: positives whose gold memory is among the first 4 bullets, or was given earlier in the cue's
 * session. The ledger rightly does not repeat what the previous turn delivered (A4 §4), and the agent has it.
 */
export function recallInContext(results: readonly CueResult[]): { k: number; n: number } {
  const positives = results.filter((result) => !isNegative(result.cue));
  const k = positives.filter((result) =>
    [...result.matched.slice(0, 4), ...result.earlier].some((id) => id && result.cue.gold.includes(id)),
  ).length;
  return { k, n: positives.length };
}

/** Recall@4: positives whose gold memory is among the first 4 bullets. */
export function recallAt4(results: readonly CueResult[]): { k: number; n: number } {
  const positives = results.filter((result) => !isNegative(result.cue));
  const k = positives.filter((result) =>
    result.matched.slice(0, 4).some((id) => id && result.cue.gold.includes(id)),
  ).length;
  return { k, n: positives.length };
}

/** False-inject rate: negatives that got any packet. */
export function fir(results: readonly CueResult[]): { k: number; n: number } {
  const negatives = results.filter((result) => isNegative(result.cue));
  return { k: negatives.filter((result) => result.packet).length, n: negatives.length };
}

/** Bullet precision per category: bullets that carry a gold memory ÷ bullets. */
export function precisionByCategory(results: readonly CueResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cat of [...new Set(results.map((result) => result.cue.cat))].sort()) {
    const of = results.filter((result) => result.cue.cat === cat);
    const bullets = of.reduce((n, result) => n + result.matched.length, 0);
    const gold = of.reduce(
      (n, result) => n + result.matched.filter((id) => id && result.cue.gold.includes(id)).length,
      0,
    );
    out[cat] = `${gold}/${bullets}`;
  }
  return out;
}

export const share = (rate: { k: number; n: number }) => (rate.n ? rate.k / rate.n : 0);
export const show = (rate: { k: number; n: number }) => `${rate.k}/${rate.n}`;

/** The first `n` cues of each category, by id: the CI subset of a split. */
export function perCategory(cues: readonly BenchCue[], n: number): BenchCue[] {
  const byCat = new Map<string, BenchCue[]>();
  for (const cue of [...cues].sort((a, b) => a.id.localeCompare(b.id))) {
    byCat.set(cue.cat, [...(byCat.get(cue.cat) ?? []), cue]);
  }
  return [...byCat.values()].flatMap((group) => group.slice(0, n));
}
