/**
 * A world-bearing scenario (A5 §3.4–3.6): R6-shaped sessions in one repo, woven with a fixed storyline of
 * user statements, annotated cues, repo changes no hook sees, a command that breaks a policy, a planted
 * secret and a planted instruction. The seed varies only the schedule (A5 §2: seeds vary the long-horizon
 * schedule generator): which sessions and prompts the storyline lands on. The world and the story are fixed.
 * It is the A/A workload (aa.ts), and P0.0c's arms build their own scenarios from the same parts.
 *
 * A storyline prompt replaces a generated prompt that no later rewind abandons, so what the story states
 * stays said. Every other human prompt keeps its generated text and gets the filler annotation (`fillerCue`).
 */
import { checkCue, plainCue, type Cue } from "./cues";
import { DEMO_STORY, DEMO_WORLD } from "./fixtures/demo-world";
import type { Corpus } from "./metrics";
import { itemId, Oracle, parseItemId, type Effect, type Subject } from "./oracle";
import { hashString, Rng } from "./rng";
import type { SimWorld } from "./session";
import {
  generateSession,
  play,
  type PlayResult,
  type SessionScript,
  type ShapeParams,
  type Step,
  type ToolSpec,
} from "./shape";
import { mentions, scopesNamed } from "./statements";

export interface WorldSpec extends Corpus {
  subjects: Subject[];
  projectFiles: Record<string, string>;
  initialTruth: Effect[];
}

/** Sessions played in order in one repo; with a world, they carry its truth and annotated cues. */
export interface Scenario {
  seed: number;
  world?: WorldSpec;
  sessions: SessionScript[];
}

/** One generated session, with no world. */
export function sessionScenario(script: SessionScript): Scenario {
  return { seed: script.seed, sessions: [script] };
}

/** One storyline prompt: what the user says, what it changes and needs, and what happens around it. */
export interface Beat {
  text: string;
  scope: string;
  sets?: Effect[];
  needs?: string[];
  allowed?: string[];
  /** A repo change no hook sees, just before the prompt. */
  repoBefore?: { files: Record<string, string | null>; sets: Effect[] };
  /** Tool calls the agent makes first in the turn. */
  calls?: ToolSpec[];
}

/** Smaller tools and context than R6, as the canonical session, so a run of a dozen sessions stays short. */
const WORLD_SHAPE: Partial<ShapeParams> = { toolScale: 0.15, growthScale: 0.1, compactAtTokens: 40_000 };
/** A5 `cross-session`: a fact said in session 1 is cued in session 7, so the schedule spans at least 7. */
const MIN_SESSIONS = 7;
const DAY_MS = 86_400_000;

/** The scenario for a seed. Deterministic: the same seed gives the same scenario. */
export function generateWorldScenario(
  seed: number,
  world: WorldSpec = DEMO_WORLD,
  story: readonly Beat[] = DEMO_STORY,
): Required<Scenario> {
  const scripts: SessionScript[] = [];
  const slots: { session: number; step: number }[] = [];
  while (slots.length < Math.ceil(story.length * 1.5) || scripts.length < MIN_SESSIONS) {
    const script = generateSession(hashString(`world-session-${scripts.length}`, seed), WORLD_SHAPE);
    slots.push(...keptPrompts(script.steps).map((step) => ({ session: scripts.length, step })));
    scripts.push(script);
  }
  const rng = new Rng(hashString("world-story", seed));
  const chosen = sample(rng, slots.length, story.length).map((at) => slots[at]!);
  const beats = new Map(chosen.map((slot, i) => [`${slot.session}/${slot.step}`, story[i]!]));
  const sessions = scripts.map((script, session) => ({
    ...script,
    steps: script.steps.flatMap((step, at) => weave(step, beats.get(`${session}/${at}`), world)),
  }));
  const scenario = { seed, world, sessions };
  checkScenario(scenario);
  return scenario;
}

/** Plays every session in order, a day apart, in one world (one repo, one store). */
export async function playScenario(scenario: Scenario, world: SimWorld): Promise<PlayResult[]> {
  const results: PlayResult[] = [];
  for (const [i, script] of scenario.sessions.entries()) {
    if (i > 0) world.advance(DAY_MS);
    results.push(await play(script, world));
  }
  return results;
}

/**
 * The annotation of a generated prompt: it needs nothing, and it allows the items it names at the scope of the
 * path it names (`fix the failing test in apps/web/src/auth.ts` allows `auth.provider@apps/web`).
 */
export function fillerCue(text: string, mode: Cue["mode"], world: WorldSpec): Cue {
  const scope = scopesNamed(text, world.scopes)[0]?.scope ?? "";
  const allowed = world.subjects
    .filter((subject) => mentions(text, subject))
    .map((subject) => itemId(subject.key, scope));
  return { ...plainCue(scope, mode), allowed };
}

/** The `prompt` and `rewind` steps that no later rewind abandons (rewinds never cross a compaction). */
export function keptPrompts(steps: readonly Step[]): number[] {
  const branch: number[] = [];
  const prompts: number[] = [];
  const abandoned = new Set<number>();
  for (const [at, step] of steps.entries()) {
    if (step.kind === "rewind") for (const gone of branch.splice(step.index)) abandoned.add(gone);
    if (step.kind === "prompt" || step.kind === "rewind") {
      branch.push(at);
      prompts.push(at);
    }
    if (step.kind === "compact") branch.splice(0);
  }
  return prompts.filter((at) => !abandoned.has(at));
}

function weave(step: Step, beat: Beat | undefined, world: WorldSpec): Step[] {
  if (step.kind !== "prompt" && step.kind !== "rewind" && step.kind !== "queued-prompt") return [step];
  if (!beat) return [{ ...step, cue: fillerCue(step.text, step.cue.mode, world) }];
  const cue = { needs: beat.needs ?? [], allowed: beat.allowed ?? [], scope: beat.scope };
  const said: Step = { ...step, text: beat.text, cue, ...(beat.sets ? { sets: beat.sets } : {}) };
  return [
    ...(beat.repoBefore ? [{ kind: "repo" as const, ...beat.repoBefore }] : []),
    said,
    ...(beat.calls ? [{ kind: "tools" as const, calls: beat.calls }] : []),
  ];
}

/** `k` distinct indexes of `n`, in increasing order. */
function sample(rng: Rng, n: number, k: number): number[] {
  const picked = new Set<number>();
  while (picked.size < k) picked.add(rng.int(0, n - 1));
  return [...picked].sort((a, b) => a - b);
}

/**
 * Throws unless every cue names only world items and every need holds a value when it is cued. Storyline
 * prompts are never abandoned, so walking the steps in order replays the truth the run will have.
 */
export function checkScenario(scenario: Required<Scenario>): void {
  const oracle = new Oracle(scenario.world.subjects);
  let seq = 0;
  const at = () => ({ seq: seq++, t: 0 });
  oracle.apply(scenario.world.initialTruth, "init", at());
  for (const script of scenario.sessions) {
    for (const step of script.steps) {
      if (step.kind === "repo") oracle.apply(step.sets, "repo", at());
      if (step.kind !== "prompt" && step.kind !== "rewind" && step.kind !== "queued-prompt") continue;
      checkCue(step.cue, oracle, scenario.world.scopes);
      oracle.apply(step.sets ?? [], "user", at());
      for (const need of step.cue.needs) {
        const { key, scope } = parseItemId(need);
        if (!oracle.truth(key, scope, seq)?.value)
          throw new Error(`"${step.text}" needs ${need}, which holds no value`);
      }
    }
  }
}
