#!/usr/bin/env bun
/**
 * The retrieval screen (audit 2026-11-06 F25): the inner loop for changes to what reaches the reader (retrieval,
 * ranking, intent, probes, sync), at $0. `bun run funnel` screens all of train (train1-6 x seeds 41-42,
 * 768 tasks) and stays the gate; this screen runs half of it, in about 0.6x the wall time, and agrees with it task by
 * task on every task it runs (docs/LAB.md recipe 1d has the measurements).
 *
 * The set is the part of train every replay cache covers with no miss: seed 41 of train1-6. The train cards, the
 * intent requests (intent-v2, every planted item has a line since the 2026-11-06 top-up) and the checked-in Haiku
 * reader cache (recipe 2a) are recorded for seeds 41-42, and the reader cache replays seed 41 whole (324 calls, 0
 * misses; its 2 misses are seed 42's), so the screen runs with the stub reader or with the paid reading replayed. A
 * retrieval change that re-renders the reader's pool still misses the reader cache: a paid top-up of the screen is
 * about half the full one. Each (suite, seed) is its own world and session, so a subset of whole suites x seeds is
 * exact; a prefix of a suite (`limit`, hidden-funnel's `--limit`) is not, because each suite clears the calendar
 * slots its own tasks ask for (`clearSlot`), and was measured to move one task in 192 (recipe 1d), so `limit` is 0.
 *
 * `select` lists the screen's covered pairs (`coveredKeys`: neither variant's planted item lacks an intent line) in
 * `packages/sim/lab/retrieval-screen.json`; `run` scores only those. It reports, per variant, how many planted items
 * the connectors returned, the cache held, the reader's pool held (`poolHas`, the retrieval figure) and the funnel
 * surfaced, and with `--baseline` (an earlier screen JSON) the fields that moved, task by task. `agree` checks the
 * screen against full-funnel runs of the same change. A screen is not a result: a change it passes still runs
 * `bun run funnel --baseline` on all of train before it is reported. Its totals' sign matched the funnel's for three
 * past changes that moved 32 or more screen tasks and not for minus-graph, which moved 6 (recipe 1d): for a change
 * that moves fewer than about 30, read the task list, not the totals.
 *
 *   bun packages/sim/src/lab/retrieval-screen.ts run [--json F] [--baseline SCREEN.json] [funnel flags]
 *     [-- hidden-funnel flags]
 *   bun packages/sim/src/lab/retrieval-screen.ts select FULL_DEFAULT.json      # rewrite the covered-pair list
 *   bun packages/sim/src/lab/retrieval-screen.ts agree FULL_BASE FULL_NEXT SCREEN_BASE SCREEN_NEXT
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The screen's grid: suites x seeds, the first `limit` tasks of each (0: all); docs/LAB.md recipe 1d. */
export const SCREEN = { suites: ["train1", "train2", "train3", "train4", "train5", "train6"], seeds: [41], limit: 0 };
export const SCREEN_FILE = join(import.meta.dir, "../../lab/retrieval-screen.json");

export interface Row {
  suite: string;
  seed: number;
  variant: "hidden" | "control";
  template: string;
  returned: boolean;
  cached: boolean;
  delivered: boolean;
  askCited?: boolean;
  poolHas?: boolean;
  inReplay?: boolean;
}

/** `suite|seed|template` (a hidden/control pair), or with the variant as `bun run funnel`'s diff keys a task. */
export function taskKey(r: Row, variant = false): string {
  return variant ? `${r.suite}|${r.variant}|${r.seed}|${r.template}` : `${r.suite}|${r.seed}|${r.template}`;
}

const FIELDS = {
  returned: (r: Row) => r.returned,
  cached: (r: Row) => r.cached,
  pool: (r: Row) => Boolean(r.poolHas),
  surfaced: (r: Row) => Boolean(r.delivered || r.askCited),
} as const;
type Field = keyof typeof FIELDS;

/**
 * Pairs whose planted items the intent replay does not miss: no variant says `inReplay: false`. An item that was not
 * cached carries no `inReplay` (nothing read it) and stays in: a retrieval change may well cache it.
 */
export function coveredKeys(rows: readonly Row[]): Set<string> {
  const pairs = new Map<string, { hidden: boolean; control: boolean; hole: boolean }>();
  for (const r of rows) {
    const p = pairs.get(taskKey(r)) ?? { hidden: false, control: false, hole: false };
    p[r.variant] = true;
    if (r.inReplay === false) p.hole = true;
    pairs.set(taskKey(r), p);
  }
  return new Set([...pairs].filter(([, p]) => p.hidden && p.control && !p.hole).map(([k]) => k));
}

/** Per task (with its variant), the retrieval fields that moved from `base` to `next`: `+pool`, `-cached`, ... */
export function retrievalDiff(base: readonly Row[], next: readonly Row[], keys?: Set<string>): Map<string, string[]> {
  const before = new Map(base.map((r) => [taskKey(r, true), r]));
  const out = new Map<string, string[]>();
  for (const r of next) {
    if (keys && !keys.has(taskKey(r))) continue;
    const b = before.get(taskKey(r, true));
    if (!b) continue;
    const moved = (Object.keys(FIELDS) as Field[]).flatMap((f) =>
      FIELDS[f](r) === FIELDS[f](b) ? [] : [`${FIELDS[f](r) ? "+" : "-"}${f}`],
    );
    if (moved.length) out.set(taskKey(r, true), moved);
  }
  return out;
}

type Counts = { n: number } & Record<Field, number>;

/** Each field's count per variant, over `keys` (pairs) when given. */
export function summarize(rows: readonly Row[], keys?: Set<string>): { hidden: Counts; control: Counts } {
  const zero = (): Counts => ({ n: 0, returned: 0, cached: 0, pool: 0, surfaced: 0 });
  const out = { hidden: zero(), control: zero() };
  for (const r of rows) {
    if (keys && !keys.has(taskKey(r))) continue;
    const c = out[r.variant];
    c.n++;
    for (const f of Object.keys(FIELDS) as Field[]) if (FIELDS[f](r)) c[f]++;
  }
  return out;
}

/**
 * Whether the screen tells what the full funnel tells about one change. Task by task: on every screen task (its
 * covered pairs, both variants), the fields that moved in the screen equal those that moved in the full funnel for
 * that task. As a verdict: the sign of the screen's change in pool and surfaced, per variant, equals the sign of the
 * full funnel's change over all of its tasks (a screen that sees no move where the funnel sees one disagrees).
 */
export function agreement(o: {
  fullBase: readonly Row[];
  fullNext: readonly Row[];
  screenBase: readonly Row[];
  screenNext: readonly Row[];
  keys?: Set<string>;
}) {
  const keys = o.keys ?? new Set(o.screenNext.map((r) => taskKey(r)));
  const fullNextKeys = new Set(o.fullNext.map((r) => taskKey(r, true)));
  const full = retrievalDiff(o.fullBase, o.fullNext, keys);
  const screen = retrievalDiff(o.screenBase, o.screenNext, keys);
  const tasks = o.screenNext.filter((r) => keys.has(taskKey(r)));
  // A screen task the full runs lack would count as agreeing when neither moved: report it instead.
  const inBoth = new Set(o.fullBase.map((r) => taskKey(r, true)).filter((k) => fullNextKeys.has(k)));
  const missing = tasks.map((r) => taskKey(r, true)).filter((k) => !inBoth.has(k));
  const disagree: { key: string; full: string[]; screen: string[] }[] = [];
  for (const r of tasks) {
    const k = taskKey(r, true);
    const f = full.get(k) ?? [];
    const s = screen.get(k) ?? [];
    if (f.join() !== s.join()) disagree.push({ key: k, full: f, screen: s });
  }
  const delta = (a: readonly Row[], b: readonly Row[], ks?: Set<string>) => {
    const x = summarize(a, ks);
    const y = summarize(b, ks);
    const d = (v: "hidden" | "control", f: "pool" | "surfaced") => y[v][f] - x[v][f];
    return {
      hiddenPool: d("hidden", "pool"),
      hiddenSurfaced: d("hidden", "surfaced"),
      decoyPool: d("control", "pool"),
      decoySurfaced: d("control", "surfaced"),
    };
  };
  const fullDelta = delta(o.fullBase, o.fullNext);
  const screenDelta = delta(o.screenBase, o.screenNext, keys);
  const signsAgree = (Object.keys(fullDelta) as (keyof typeof fullDelta)[]).every(
    (k) => Math.sign(fullDelta[k]) === Math.sign(screenDelta[k]),
  );
  return {
    tasks: tasks.length,
    agree: tasks.length - disagree.length - missing.filter((k) => !disagree.some((d) => d.key === k)).length,
    missing,
    disagree,
    fullMoved: full.size,
    screenMoved: screen.size,
    fullDelta,
    screenDelta,
    signsAgree,
  };
}

/**
 * `bun run funnel` arguments for the screen: its grid and `--json` first, the caller's funnel flags, then `--limit`
 * and the caller's hidden-funnel flags after `--`. The grid is the screen's; a caller's `--suite`/`--seeds` is refused.
 */
export function screenArgs(screen: typeof SCREEN, passthrough: readonly string[], json: string): string[] {
  const cut = passthrough.indexOf("--");
  const mine = cut < 0 ? [...passthrough] : passthrough.slice(0, cut);
  const theirs = cut < 0 ? [] : passthrough.slice(cut + 1);
  for (const f of ["--suite", "--seeds", "--json"]) {
    if (mine.includes(f)) throw new Error(`${f} is the screen's own; run bun run funnel for another grid`);
  }
  const hidden = [...(screen.limit > 0 ? ["--limit", String(screen.limit)] : []), ...theirs];
  return [
    "--suite",
    screen.suites.join(","),
    "--seeds",
    screen.seeds.join(","),
    "--json",
    json,
    ...mine,
    ...(hidden.length ? ["--", ...hidden] : []),
  ];
}

const rowsOf = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { perTask: Row[] }).perTask;
const screenKeys = () => new Set((JSON.parse(readFileSync(SCREEN_FILE, "utf8")) as { covered: string[] }).covered);

function line(label: string, c: { hidden: Counts; control: Counts }): string {
  const h = c.hidden;
  const d = c.control;
  return (
    `${label}: hidden returned ${h.returned}/${h.n}, cached ${h.cached}, pool ${h.pool}, surfaced ${h.surfaced}; ` +
    `decoys returned ${d.returned}/${d.n}, cached ${d.cached}, pool ${d.pool}, surfaced ${d.surfaced}`
  );
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "select") {
    const [full] = rest;
    if (!full) throw new Error("select FULL_DEFAULT.json (a bun run funnel --json of the default on train)");
    const rows = rowsOf(full).filter((r) => SCREEN.suites.includes(r.suite) && SCREEN.seeds.includes(r.seed));
    const covered = [...coveredKeys(rows)].sort();
    const all = new Set(rows.map((r) => taskKey(r))).size;
    writeFileSync(
      SCREEN_FILE,
      JSON.stringify({ from: full.split("/").pop(), screen: SCREEN, pairs: all, covered }, null, 1) + "\n",
    );
    console.log(`retrieval-screen: ${covered.length} of ${all} pairs covered, written to ${SCREEN_FILE}`);
    return 0;
  }
  if (cmd === "agree") {
    const [fb, fn, sb, sn] = rest;
    if (!sn) throw new Error("agree FULL_BASE FULL_NEXT SCREEN_BASE SCREEN_NEXT");
    const r = agreement({
      fullBase: rowsOf(fb!),
      fullNext: rowsOf(fn!),
      screenBase: rowsOf(sb!),
      screenNext: rowsOf(sn!),
      keys: screenKeys(),
    });
    const shown = { ...r, disagree: r.disagree.slice(0, 20), missing: r.missing.slice(0, 20) };
    console.log(
      JSON.stringify({ ...shown, disagreeCount: r.disagree.length, missingCount: r.missing.length }, null, 1),
    );
    return r.disagree.length === 0 && r.missing.length === 0 && r.signsAgree ? 0 : 1;
  }
  if (cmd === "run") {
    let json = "";
    let baseline = "";
    const pass: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const own = (rest[i] === "--json" || rest[i] === "--baseline") && pass.indexOf("--") < 0;
      if (!own) {
        pass.push(rest[i]!);
        continue;
      }
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${rest[i]} needs a file`);
      if (rest[i++] === "--json") json = value;
      else baseline = value;
    }
    const scratch = mkdtempSync(join(tmpdir(), "eden-retrieval-screen-"));
    const out = json || join(scratch, "screen.json");
    const funnel = join(import.meta.dir, "funnel.ts");
    const t0 = performance.now();
    const res = spawnSync(process.execPath, [funnel, ...screenArgs(SCREEN, pass, out)], { stdio: "inherit" });
    const secs = (performance.now() - t0) / 1_000;
    // 3: reader misses (the funnel's miss gate), the score still printed; anything else is a failed run.
    if (res.status !== 0 && res.status !== 3) {
      rmSync(scratch, { recursive: true, force: true });
      return res.status ?? 1;
    }
    if (!existsSync(out)) {
      // `--help`, or a funnel that stopped before writing rows: nothing to score.
      rmSync(scratch, { recursive: true, force: true });
      return res.status ?? 0;
    }
    const keys = screenKeys();
    const rows = rowsOf(out);
    console.log(`\nRETRIEVAL SCREEN (${keys.size} covered pairs; a screen, not a result; ${secs.toFixed(1)} s)`);
    console.log(line("  screen", summarize(rows, keys)));
    if (baseline) {
      const base = rowsOf(baseline);
      console.log(line("  baseline", summarize(base, keys)));
      const d = retrievalDiff(base, rows, keys);
      console.log(`  moved against ${baseline}: ${d.size} tasks`);
      for (const [k, f] of [...d].slice(0, 40)) console.log(`    ${k}  ${f.join(" ")}`);
      if (d.size > 40) console.log(`    … ${d.size - 40} more`);
    }
    rmSync(scratch, { recursive: true, force: true });
    return res.status ?? 0;
  }
  console.error("usage: retrieval-screen.ts run|select|agree (the header of retrieval-screen.ts)");
  return 2;
}

if (import.meta.main) {
  // A bad argument is a usage error (exit 2, one line), as in the lab's strict CLIs, not a stack trace.
  const code = await main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`retrieval-screen: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  });
  process.exit(code);
}
