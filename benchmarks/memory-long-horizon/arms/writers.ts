/**
 * The `spawn-writers` arm (A5 §4; A1 D2, #98): 200 writer events, one process each, each carrying a distinct fact:
 * 100 typed prompts and 100 Read results in parallel pairs, whose PostToolUse hooks run concurrently. Afterwards
 * the store must hold all 200 in rows of their own (200 facts in at least 200 distinct rows), no two rows may share
 * an id, and the ledger must hold one turn record per human prompt (A4 §4: "no lost ledger entries").
 *
 * Rows, ids and ledger entries are inside Eden's store, which the harness never parses. It reads them through an
 * entry point the arm defines, the way a user would inspect a store:
 *
 *   eden memory dump --json   →   {"rows": [{"id", "text"}…], "ledger": [{"window", "k", "prompt_id"?}…]}
 *
 * run in the repo with the hooks' environment. Until a slice provides it, the checks that need it fail. A5 asks
 * concurrency arms for ≥ 20 repetitions with 0 failures; CI runs one, `--scale full` runs 20, each in a home of its
 * own and checked on its own.
 */
import { countBy } from "../harness/metrics";
import type { SimWorld } from "../harness/session";
import { monorepo } from "./fixtures/world";
import { check, Driver, jsonOut, read, type Arm, type ArmRun, type Check } from "./kit";

const PROMPTS = 100;
const READ_PAIRS = 50;

export interface Dump {
  rows: { id: string; text: string }[];
  ledger: { window: string; k: string; prompt_id?: string }[];
}

/** The dump entry point's answer, when it gave one in the contract's shape. */
export function readDump(value: unknown): Dump | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { rows, ledger } = value as Partial<Dump>;
  if (!Array.isArray(rows) || !Array.isArray(ledger)) return undefined;
  if (!rows.every((row) => typeof row?.id === "string" && typeof row?.text === "string")) return undefined;
  return { rows, ledger };
}

/** The fact a writer event carries, with its marker: what a row must contain to hold it. */
const fact = (rep: number, n: number) => {
  const marker = `w${rep}m${String(n).padStart(3, "0")}`;
  return { marker, text: `The build tag for module ${marker} is tag-${marker}.` };
};

/**
 * One repetition, in a home of its own: a session of 100 turns, each a fact prompt, every other one with a pair of
 * fact Reads; then the store's dump.
 */
async function writeFacts(run: ArmRun, rep: number): Promise<Repetition> {
  const spec = monorepo();
  const world = run.world(spec, { home: `rep-${rep}` });
  const session = await Driver.start(world, spec);
  const markers: string[] = [];
  for (let n = 0; n < PROMPTS; n++) {
    const said = fact(rep, n);
    markers.push(said.marker);
    const pair = n < READ_PAIRS * 2 && n % 2 === 0 ? [PROMPTS + n, PROMPTS + n + 1].map((k) => fact(rep, k)) : [];
    markers.push(...pair.map((item) => item.marker));
    const reads = pair.map((item) => read(`packages/cli/src/${item.marker}.ts`, `// ${item.text}\n`));
    await session.turn(said.text, { tools: reads.length ? [reads] : [] });
  }
  await session.end();
  return { world, markers, dump: readDump(jsonOut(run.cli(world, ["memory", "dump", "--json"]))) };
}

interface Repetition {
  world: SimWorld;
  markers: string[];
  dump: Dump | undefined;
}

/** What failed in one repetition, by check, in words; a check absent from the map passed. */
function repetitionFailures(rep: Repetition): Map<string, string> {
  const out = new Map<string, string>();
  const calls = rep.world.log.flatMap((record) => record.invocations);
  const failing = calls.filter((call) => call.exitCode !== 0);
  if (failing.length) {
    const how = Object.entries(countBy(failing.map((call) => (call.timedOut ? "timed out" : `exit ${call.exitCode}`))));
    out.set(
      "exit-0",
      `${failing.length} of ${calls.length} invocations (${how.map(([kind, n]) => `${kind} ×${n}`).join(", ")})`,
    );
  }
  if (!rep.dump) {
    for (const name of ["dump", "ledger", "rows", "unique-ids"]) out.set(name, "no dump in the contract's shape");
    return out;
  }
  const holding = (marker: string) => rep.dump!.rows.filter((row) => row.text.includes(marker));
  const lost = rep.markers.filter((marker) => holding(marker).length === 0);
  const rows = new Set(rep.markers.flatMap((marker) => holding(marker).map((row) => row.id))).size;
  if (lost.length || rows < rep.markers.length) {
    const kept = `${rep.markers.length - lost.length} of ${rep.markers.length} facts kept, in ${rows} rows`;
    out.set("rows", `${kept}; lost e.g. ${lost.slice(0, 3).join(", ") || "none"}`);
  }
  const ids = rep.dump.rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) out.set("unique-ids", `${ids.length - new Set(ids).size} duplicate ids`);
  const turns = new Set(rep.dump.ledger.filter((entry) => entry.k === "turn").map((entry) => entry.prompt_id)).size;
  if (turns < PROMPTS) out.set("ledger", `${turns} turn records for ${PROMPTS} human prompts`);
  return out;
}

/**
 * Each check holds in every repetition (A5: "≥ 20 repetitions with 0 failures"). A failing check names the
 * repetitions it failed in.
 */
function writerChecks(reps: readonly Repetition[]): Check[] {
  const failures = reps.map(repetitionFailures);
  return ["dump", "exit-0", "ledger", "rows", "unique-ids"].map((name) => {
    const failed = failures.flatMap((map, rep) => (map.has(name) ? [`rep ${rep}: ${map.get(name)}`] : []));
    const writers = reps.length * (PROMPTS + READ_PAIRS * 2);
    return check(
      name,
      failed.length === 0,
      failed.length ? failed.slice(0, 3).join("; ") : `held in ${reps.length} repetitions (${writers} writers)`,
    );
  });
}

export const spawnWriters: Arm = {
  id: "spawn-writers",
  flagged: false,
  async run(run) {
    const repetitions = run.options.scale === "full" ? 20 : 1;
    const reps: Repetition[] = [];
    for (let rep = 0; rep < repetitions; rep++) reps.push(await writeFacts(run, rep));
    return writerChecks(reps);
  },
};
