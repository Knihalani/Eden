/**
 * F5's subagent-simulated pilot (docs/research/f5-rule-sheet.md §5). The Anthropic API has no credit, so Haiku
 * subagents answer the push check's prompts instead of the API. Two commands:
 *
 *   bun packages/sim/lab/f5/pilot.ts build OUTDIR DUMP.jsonl...   # select rows, write batch files and a key
 *   bun packages/sim/lab/f5/pilot.ts score OUTDIR                 # read OUTDIR/answers/*.jsonl, print the table
 *
 * Rows are `--check-dump` rows recorded with `pushCheckSheet` on (the calls failed: $0), so each holds the check's
 * exact input with its sheet. Each selected row is asked twice where it can differ: with its sheet (arm S) and
 * without (arm B, main's prompt). Sets: T (the planted item, or the look-alike, is on the sheet and not in the pool:
 * only S can name it), H (it is in the pool: does the sheet change the verdict?) and N (neutral: any yes).
 * A batch file holds one user's prompts (suite, seed, variant), so the system message and the sheet are written once
 * a file; each prompt's user turn follows in full. Prompts are sim data only.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { CHECK_SYSTEM, checkMessages, parseCompareSheet, type PushCheckInput } from "@eden/engine";

interface Row {
  suite: string;
  seed: number;
  variant: string;
  template: string;
  planted: string;
  request: string;
  today: string;
  items: { id: string; source: string; title: string; date: string; from: string; text: string }[];
  hash?: string[];
  sheet?: PushCheckInput["sheet"];
}

const [cmd, out, ...files] = process.argv.slice(2);
if (!cmd || !out) throw new Error("usage: pilot.ts build OUTDIR DUMP... | score OUTDIR");

/** A seeded shuffle, so a sample is the same on every build. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const inputOf = (r: Row, sheet: boolean, refs = false): PushCheckInput => ({
  request: r.request,
  today: r.today,
  items: r.items.map((it, i) => ({ ...it, hash: r.hash?.[i] ?? "" })),
  ...(sheet && r.sheet?.length ? { sheet: r.sheet, ...(refs ? { sheetRefs: true } : {}) } : {}),
});
/** `--arms S,B` (default) or e.g. `R`: R is S with pool items on the sheet sent as pointers (`pushCheckSheetRefs`). */
const ARMS = (process.env.PILOT_ARMS ?? "").split(",").filter(Boolean) as ("S" | "B" | "R")[];

if (cmd === "build") {
  const rows: Row[] = [];
  for (const f of files)
    for (const line of readFileSync(f, "utf8").split("\n"))
      if (line.trim()) {
        const r = JSON.parse(line) as Row;
        // The task's first check (a second pass re-reads the same request).
        if (
          !rows.some(
            (x) => x.suite === r.suite && x.seed === r.seed && x.variant === r.variant && x.template === r.template,
          )
        )
          rows.push(r);
      }
  // F5's realism stress (§8): pad each sheet to PILOT_PAD cards with other users' constraint cards (base-world items
  // only: no planted fact or look-alike of any task), at random places among the user's own (newest first: the
  // padding models a heavier user's other cards spread over time), then keep the first PILOT_CAP (0: all).
  const worldOf = (r: Row) => `${r.suite}|${r.seed}|${r.variant}`;
  // Which template planted each item of each world: a card planted for the same template elsewhere (another seed,
  // the reworded suite) is the same fact, never a distractor.
  const templateOf = new Map(rows.map((r) => [`${worldOf(r)}|${r.planted}`, r.template] as const));
  const pool: { card: NonNullable<Row["sheet"]>[number]; world: string; template?: string }[] = [];
  const seenStatement = new Set<string>();
  for (const r of rows)
    for (const c of r.sheet ?? []) {
      const k = c.statement.toLowerCase();
      if (seenStatement.has(k)) continue;
      seenStatement.add(k);
      const template = templateOf.get(`${worldOf(r)}|${c.id}`);
      pool.push({ card: c, world: worldOf(r), ...(template ? { template } : {}) });
    }
  const hash = (t: string) => [...t].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  // Every template planted in a world: a card planted for any of them in another world is one of this user's own
  // facts in another form, never a distractor. One padded sheet per user (seeded by the world), as a user has one.
  const worldTemplates = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = worldTemplates.get(worldOf(r)) ?? new Set<string>();
    worldTemplates.set(worldOf(r), set.add(r.template));
  }
  const padded = (r: Row, pad: number, cap: number): Row["sheet"] => {
    const own = r.sheet ?? [];
    const mine = new Set(own.map((c) => c.statement.toLowerCase()));
    const theirs = worldTemplates.get(worldOf(r))!;
    const others = shuffled(
      pool.filter(
        (p) =>
          p.world !== worldOf(r) &&
          !(p.template && theirs.has(p.template)) &&
          !mine.has(p.card.statement.toLowerCase()),
      ),
      hash(worldOf(r)),
    )
      .slice(0, Math.max(0, pad - own.length))
      // Another user's ids are not this user's: a named distractor must never match a pooled item or the planted one.
      .map((p, i) => ({ ...p.card, id: `pad:${i}:${p.card.id}` }));
    // Interleave: each distractor at a seeded random place among the user's own cards.
    const out = [...own];
    let h = hash(`${worldOf(r)}|pad`);
    for (const d of others) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      out.splice(h % (out.length + 1), 0, d);
    }
    return cap > 0 ? out.slice(0, cap) : out;
  };
  const PAD = Number(process.env.PILOT_PAD ?? 0);
  const CAP = Number(process.env.PILOT_CAP ?? 0);
  if (process.env.PILOT_STATS) {
    // How often a cap keeps the planted fact's (or the look-alike's) card, by sheet size: $0, no model.
    for (const variant of ["hidden", "control"]) {
      const on = rows.filter((r) => r.variant === variant && r.sheet?.some((c) => c.id === r.planted));
      for (const pad of [0, 150, 300, 500])
        console.log(
          `${variant} on own sheet ${on.length}; padded to ${pad || "none"}: ` +
            [0, 60, 80, 120]
              .map((cap) => {
                const kept = on.filter((r) => padded(r, pad, cap)!.some((c) => c.id === r.planted)).length;
                return `cap ${cap || "none"} keeps ${kept}`;
              })
              .join(", "),
        );
    }
    process.exit(0);
  }
  if (PAD > 0 || CAP > 0) for (const r of rows) if (r.sheet?.length) r.sheet = padded(r, PAD, CAP);
  const inPool = (r: Row) => r.items.some((it) => it.id === r.planted);
  const onSheet = (r: Row) => !!r.sheet?.some((c) => c.id === r.planted);
  const sets: Record<string, Row[]> = {
    Th: rows.filter((r) => r.variant === "hidden" && !inPool(r) && onSheet(r)),
    Tc: rows.filter((r) => r.variant === "control" && !inPool(r) && onSheet(r)),
    Hh: shuffled(
      rows.filter((r) => r.variant === "hidden" && inPool(r) && r.sheet?.length),
      1,
    ).slice(0, 40),
    Hc: shuffled(
      rows.filter((r) => r.variant === "control" && inPool(r) && r.sheet?.length),
      2,
    ).slice(0, 40),
    N: shuffled(
      rows.filter((r) => r.variant === "neutral" && r.sheet?.length),
      3,
    ).slice(0, 40),
  };
  // Which arms each set is asked in: T can only be named with the sheet.
  const base: Record<string, ("S" | "B" | "R")[]> = {
    Th: ["S"],
    Tc: ["S"],
    Hh: ["S", "B"],
    Hc: ["S", "B"],
    N: ["S", "B"],
  };
  const only = (process.env.PILOT_SETS ?? "").split(",").filter(Boolean);
  for (const k of Object.keys(sets)) if (only.length && !only.includes(k)) delete sets[k];
  const arms = ARMS.length ? Object.fromEntries(Object.keys(base).map((k) => [k, ARMS])) : base;
  const key: Record<string, unknown>[] = [];
  const byFile = new Map<string, { sheet: string; prompts: string[] }>();
  for (const [set, rs] of Object.entries(sets))
    for (const r of rs)
      for (const arm of arms[set]!) {
        const id = `${set}.${arm}.${r.suite}.${r.seed}.${r.variant}.${r.template}`;
        const msgs = checkMessages(inputOf(r, arm !== "B", arm === "R"));
        const sheetMsg = arm !== "B" ? msgs[1]!.content : "";
        const user = msgs.at(-1)!.content;
        // A batch file shows one sheet: prompts with another sheet (a card made between two requests) go elsewhere.
        const fileKey = `${arm}-${r.suite}-${r.seed}-${r.variant}-${hash(sheetMsg).toString(36)}`;
        const f = byFile.get(fileKey) ?? { sheet: sheetMsg, prompts: [] };
        byFile.set(fileKey, f);
        f.prompts.push(`=== PROMPT ${id}\n${user}`);
        key.push({
          id,
          set,
          arm,
          planted: r.planted,
          plantedItem: r.items.findIndex((it) => it.id === r.planted),
          plantedRule: r.sheet?.findIndex((c) => c.id === r.planted) ?? -1,
          items: r.items.length,
          rules: arm !== "B" ? (r.sheet?.length ?? 0) : 0,
        });
      }
  mkdirSync(`${out}/batches`, { recursive: true });
  mkdirSync(`${out}/answers`, { recursive: true });
  let n = 0;
  const list: string[] = [];
  for (const [fileKey, f] of byFile) {
    // At most 12 prompts a batch file.
    for (let i = 0; i < f.prompts.length; i += 12) {
      const name = `${fileKey}-${i / 12}`;
      const head =
        `SYSTEM MESSAGE (the same for every prompt in this file):\n${CHECK_SYSTEM}\n\n` +
        (f.sheet ? `FIRST USER BLOCK (the same for every prompt in this file):\n${f.sheet}\n\n` : "") +
        `Each prompt below is the final user block of a separate, independent request. Answer each one on its own.\n\n`;
      writeFileSync(`${out}/batches/${name}.txt`, head + f.prompts.slice(i, i + 12).join("\n\n"));
      list.push(name);
      n += f.prompts.slice(i, i + 12).length;
    }
  }
  writeFileSync(`${out}/key.json`, JSON.stringify(key));
  writeFileSync(`${out}/batches.txt`, list.join("\n"));
  console.log(
    `${n} prompts in ${list.length} batch files; sets ${Object.entries(sets)
      .map(([k, v]) => `${k} ${v.length}`)
      .join(", ")}`,
  );
} else if (cmd === "score") {
  const key = JSON.parse(readFileSync(`${out}/key.json`, "utf8")) as {
    id: string;
    set: string;
    arm: string;
    plantedItem: number;
    plantedRule: number;
    items: number;
    rules: number;
  }[];
  const replies = new Map<string, string>();
  for (const f of readdirSync(`${out}/answers`))
    for (const line of readFileSync(`${out}/answers/${f}`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { id: string; reply: unknown };
        replies.set(j.id, typeof j.reply === "string" ? j.reply : JSON.stringify(j.reply));
      } catch {
        // A line the subagent broke is a missing answer.
      }
    }
  const table = new Map<
    string,
    { n: number; answered: number; unreadable: number; named: number; anyYes: number; ruleYes: number }
  >();
  for (const k of key) {
    const t = table.get(`${k.set}.${k.arm}`) ?? { n: 0, answered: 0, unreadable: 0, named: 0, anyYes: 0, ruleYes: 0 };
    table.set(`${k.set}.${k.arm}`, t);
    t.n++;
    const reply = replies.get(k.id);
    if (reply === undefined) continue;
    t.answered++;
    const got = parseCompareSheet(reply, k.items, k.rules);
    if (!got) {
      t.unreadable++;
      continue;
    }
    if (got.items.includes(k.plantedItem) || (k.plantedRule >= 0 && got.rules.includes(k.plantedRule))) t.named++;
    if (got.items.length + got.rules.length > 0) t.anyYes++;
    if (got.rules.length > 0) t.ruleYes++;
  }
  console.log("set.arm   n  answered unreadable  planted-or-lookalike named  any yes  any rule named");
  for (const [k, t] of [...table].sort())
    console.log(
      `${k.padEnd(6)} ${String(t.n).padStart(4)} ${String(t.answered).padStart(8)} ${String(t.unreadable).padStart(10)} ` +
        `${String(t.named).padStart(26)} ${String(t.anyYes).padStart(8)} ${String(t.ruleYes).padStart(15)}`,
    );
}
