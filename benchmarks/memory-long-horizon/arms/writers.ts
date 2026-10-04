/**
 * The `spawn-writers` arm (A5 §4; A1 D2, #98): 200 writer events, one process each, each carrying a distinct fact:
 * 100 typed prompts and 100 Read results in parallel pairs, whose PostToolUse hooks run concurrently. Afterwards
 * the store must hold all 200 (a row each), no two rows may share an id, and the ledger must hold one turn record
 * per human prompt (A4 §4: "no lost ledger entries").
 *
 * Rows, ids and ledger entries are inside Eden's store, which the harness never parses. It reads them through an
 * entry point the arm defines, the way a user would inspect a store:
 *
 *   eden memory dump --json   →   {"rows": [{"id", "text"}…], "ledger": [{"window", "k", "prompt_id"?}…]}
 *
 * run in the repo with the hooks' environment. Until a slice provides it, the checks that need it fail. A5 asks
 * concurrency arms for ≥ 20 repetitions with 0 failures; CI runs one, `--scale full` runs 20.
 */
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

/** One repetition: a session of 100 turns, each a fact prompt, every other one with a pair of fact Reads. */
async function writeFacts(run: ArmRun, rep: number): Promise<{ world: SimWorld; markers: string[]; prompts: number }> {
  const spec = monorepo();
  const world = run.world(spec, { projectName: `repo-${rep}` });
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
  return { world, markers, prompts: PROMPTS };
}

function writerChecks(run: ArmRun, reps: Awaited<ReturnType<typeof writeFacts>>[]): Check[] {
  const calls = reps.flatMap((rep) => rep.world.log.flatMap((record) => record.invocations));
  const failing = calls.filter((call) => call.exitCode !== 0);
  const dump = readDump(jsonOut(run.cli(reps[0]!.world, ["memory", "dump", "--json"])));
  const exits = check(
    "exit-0",
    failing.length === 0,
    `${failing.length} of ${calls.length} writer invocations exited non-zero`,
  );
  if (!dump) {
    const missing = "`eden memory dump --json` gave no dump in the contract's shape";
    return [
      check("dump", false, missing),
      exits,
      ...["ledger", "rows", "unique-ids"].map((name) => check(name, false, missing)),
    ];
  }
  const texts = dump.rows.map((row) => row.text);
  const markers = reps.flatMap((rep) => rep.markers);
  const lost = markers.filter((marker) => !texts.some((text) => text.includes(marker)));
  const lostSome = lost.slice(0, 3).join(", ") || "none";
  const ids = dump.rows.map((row) => row.id);
  const duplicates = ids.length - new Set(ids).size;
  const turns = new Set(dump.ledger.filter((entry) => entry.k === "turn").map((entry) => entry.prompt_id)).size;
  const prompts = reps.reduce((n, rep) => n + rep.prompts, 0);
  return [
    check("dump", true, `${dump.rows.length} rows, ${dump.ledger.length} ledger entries`),
    exits,
    check("ledger", turns >= prompts, `${turns} turn records for ${prompts} human prompts`),
    check(
      "rows",
      lost.length === 0,
      `${markers.length - lost.length} of ${markers.length} facts in rows; lost e.g. ${lostSome}`,
    ),
    check("unique-ids", duplicates === 0, `${duplicates} duplicate ids among ${ids.length} rows`),
  ];
}

export const spawnWriters: Arm = {
  id: "spawn-writers",
  flagged: false,
  async run(run) {
    const repetitions = run.options.scale === "full" ? 20 : 1;
    const reps = [];
    for (let rep = 0; rep < repetitions; rep++) reps.push(await writeFacts(run, rep));
    return writerChecks(run, reps);
  },
};
