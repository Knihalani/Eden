/**
 * M47.1 product help ledger (wrap injectBody + hook inject).
 *
 *   bun benchmarks/memory-holdout/run-help.ts
 *
 * Scripted live-shaped sessions. On vs EDEN_MEMORY=0. Writes HELP.md.
 * Does not retune the ranker. Does not edit SAVINGS.md. Not BrainMemory.
 * k = product default (EDEN_MEMORY_CAP unset → 6).
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHook } from "../../packages/cli/src/hook.ts";
import { MEMORY_MARK, memoryRetrieveCap, openMemory } from "../../src/index.ts";
import { loadHoldoutFixture, type HoldoutCase } from "./run-holdout.ts";
import { additionalContextOf, hitsIn } from "./run-tools.ts";

export const HOLD_DIR = import.meta.dir;
export const HELP_PATH = join(HOLD_DIR, "HELP.md");

const MATH_CUE = "What is 17 times 23?";
const SQLITE_FACT = "Use sqlite.";
const CLERK_FACT = "Auth is Clerk.";
const LIVE_CUE = "What sqlite database do we use?";

type Host = "wrap" | "hook";
type Klass = "helped" | "no-lift" | "harmed";
type Rec = Record<string, unknown>;

type HelpCase = {
  id: string;
  title: string;
  kind: "recall" | "omit";
  session_id: string;
  observe: string[];
  cue: string;
  cwd: string;
  gold_needles: string[];
  stale_needles: string[];
  junk_needles: string[];
  keep_needles: string[];
  leftover_needles: string[];
};

export type HelpRow = {
  id: string;
  host: Host;
  klass: Klass;
  on: string;
  off: string;
  delta: string;
  control: "EDEN_MEMORY=0";
  notes: string;
  on_packet: string;
  off_packet: string;
  gold_on: string[];
  gold_miss: string[];
  store_n: number;
  live: string;
};

export type HelpRun = {
  date: string;
  bun: string;
  k: number;
  rows: HelpRow[];
  helped: number;
  no_lift: number;
  harmed: number;
};

function asRec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function casesFromHoldout(): HelpCase[] {
  const fix = loadHoldoutFixture();
  return fix.cases.map((c) => fromHoldout(c));
}

function fromHoldout(c: HoldoutCase): HelpCase {
  const session = c.session_id || c.cue.session_id || `help-${c.id}`;
  return {
    id: c.id,
    title: c.title,
    kind: "recall",
    session_id: session,
    observe: c.observe.map((e) => String(e.prompt ?? "")).filter(Boolean),
    cue: String(c.cue.prompt ?? ""),
    cwd: String(c.cue.cwd ?? c.observe[0]?.cwd ?? ""),
    gold_needles: c.gold_needles ?? [],
    stale_needles: c.stale_needles ?? [],
    junk_needles: c.junk_needles ?? [],
    keep_needles: c.keep_needles ?? [],
    leftover_needles: [],
  };
}

function silentMath(): HelpCase {
  return {
    id: "silent-math",
    title: "Seeded sqlite and Clerk, math cue omitted",
    kind: "omit",
    session_id: "help-silent-math",
    observe: [SQLITE_FACT, CLERK_FACT],
    cue: MATH_CUE,
    cwd: "/tmp/eden-help-silent-math",
    gold_needles: [],
    stale_needles: [],
    junk_needles: [],
    keep_needles: [],
    leftover_needles: ["sqlite", "Clerk"],
  };
}

function assertProtocol(): void {
  if (process.env.EDEN_MEMORY_CAP) throw new Error("EDEN_MEMORY_CAP must stay unset (k default, not 40)");
  const k = memoryRetrieveCap();
  if (k !== 6) throw new Error(`memoryRetrieveCap ${k} !== 6`);
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  const keys = [...Object.keys(vars), "EDEN_MEMORY_CAP"];
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.EDEN_MEMORY_CAP;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function armEnv(arm: "on" | "off", home: string, memDir: string): Record<string, string | undefined> {
  return {
    EDEN_MEMORY: arm === "off" ? "0" : undefined,
    EDEN_HOME: home,
    EDEN_MEMORY_DIR: memDir,
    EDEN_KNOW: "0",
    EDEN_MEMORY_CAP: undefined,
    EDEN_MEMORY_MIN: undefined,
    EDEN_MEMORY_AGENT: undefined,
    EDEN_MEMORY_PROJECT: undefined,
    EDEN_MEMORY_PARENT: undefined,
    EDEN_MEMORY_CHILD: undefined,
    EDEN_MEMORY_SESSION: undefined,
  };
}

function packetFromMessages(list: unknown[]): string {
  const out: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const role = String((m as { role?: unknown }).role ?? "");
    const content = (m as { content?: unknown }).content;
    if (role === "system" && typeof content === "string" && content.includes(MEMORY_MARK)) out.push(content);
  }
  return out.join("\n");
}

function hookPacket(out: unknown): string {
  const ctx = additionalContextOf(asRec(out));
  if (!ctx.includes(MEMORY_MARK)) return "";
  const blocks = ctx
    .split(/(?=Eden Memory:)/)
    .map((s) => s.trim())
    .filter((s) => s.includes(MEMORY_MARK));
  const uniq: string[] = [];
  for (const b of blocks) if (!uniq.includes(b)) uniq.push(b);
  return uniq.join("\n");
}

function countJsonl(memDir: string): number {
  let n = 0;
  const walk = (dir: string) => {
    let ents: import("node:fs").Dirent[] = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === "memories.jsonl") {
        try {
          n += readFileSync(p, "utf8")
            .split("\n")
            .filter((l) => l.trim()).length;
        } catch {}
      }
    }
  };
  walk(memDir);
  return n;
}

function submit(c: HelpCase): Rec {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: c.session_id,
    cwd: c.cwd,
    prompt: "",
  };
}

async function seedHook(c: HelpCase, memDir: string): Promise<void> {
  for (const prompt of c.observe) {
    await respondToHook({ ...submit(c), prompt });
  }
  void memDir;
}

function seedWrap(c: HelpCase, memDir: string): void {
  const mem = openMemory({ dir: memDir });
  try {
    for (const prompt of c.observe) mem.observe([{ role: "user", content: prompt }]);
  } finally {
    try {
      mem.close();
    } catch {}
  }
}

async function probeHook(c: HelpCase, cue: string): Promise<string> {
  const out = await respondToHook({ ...submit(c), prompt: cue });
  return hookPacket(out);
}

function probeWrap(c: HelpCase, memDir: string, cue: string): string {
  const mem = openMemory({ dir: memDir });
  try {
    const body = mem.injectBody({ messages: [{ role: "user", content: cue }] });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return packetFromMessages(messages);
  } finally {
    try {
      mem.close();
    } catch {}
  }
}

function cloneStore(src: string): { home: string; mem: string } {
  const home = mkdtempSync(join(tmpdir(), "eden-m47-arm-"));
  const mem = join(home, "memory");
  cpSync(src, mem, { recursive: true });
  return { home, mem };
}

function preview(packet: string, needles: string[]): string {
  if (!packet.trim()) return "empty";
  const hit = hitsIn(packet, needles);
  if (hit.hit.length) return `gold: ${hit.hit.join("; ")}`;
  const text = packet.replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function classify(
  c: HelpCase,
  onPacket: string,
  offPacket: string,
  live: string,
): { klass: Klass; on: string; off: string; delta: string; notes: string } {
  const onEmpty = !onPacket.trim();
  const offEmpty = !offPacket.trim();
  const same = onPacket.trim() === offPacket.trim();
  const notes: string[] = [];
  if (!offEmpty) notes.push("off arm was not empty");

  if (c.kind === "omit") {
    const leftover = hitsIn(onPacket, c.leftover_needles).hit;
    if (!onEmpty) {
      notes.push(leftover.length ? `leftover ${leftover.join("; ")}` : "on-arm Eden Memory: on a math cue");
      notes.push("always-on junk");
      if (live) notes.push(live);
      return {
        klass: "harmed",
        on: leftover.length ? `leftover: ${leftover.join("; ")}` : "Eden Memory: present",
        off: offEmpty ? "empty" : "packet",
        delta: "leftover on only",
        notes: notes.join("; "),
      };
    }
    notes.push("packet omitted both arms");
    notes.push(`stored ${c.observe.join(" / ")}`);
    notes.push(`cue “${c.cue}”`);
    if (live) notes.push(live);
    return {
      klass: "no-lift",
      on: "empty",
      off: offEmpty ? "empty" : preview(offPacket, c.leftover_needles),
      delta: same ? "0" : "Δ≠0",
      notes: notes.join("; "),
    };
  }

  const gold = hitsIn(onPacket, c.gold_needles);
  const goldOff = hitsIn(offPacket, c.gold_needles);
  const junk = hitsIn(onPacket, c.junk_needles);
  const stale = hitsIn(onPacket, c.stale_needles);
  const keep = hitsIn(onPacket, c.keep_needles);
  const goldOk = gold.miss.length === 0 && c.gold_needles.length > 0;
  const junkOk = junk.hit.length === 0;
  const staleOk = stale.hit.length === 0;

  if (c.stale_needles.length)
    notes.push(staleOk ? `${c.stale_needles.join("; ")} absent` : `stale in packet: ${stale.hit.join("; ")}`);
  if (c.junk_needles.length) notes.push(junkOk ? "chatter absent" : `junk leaked: ${junk.hit.join("; ")}`);
  if (c.keep_needles.length)
    notes.push(keep.hit.length ? `kept ${keep.hit.join("; ")}` : `${c.keep_needles.join("; ")} not in inject`);
  if (gold.miss.length) notes.push(`LOSS: gold miss ${gold.miss.join("; ")}`);

  const misleading = !junkOk || !staleOk || (!goldOk && !onEmpty && gold.hit.length === 0);
  if (misleading && !onEmpty) {
    const bits = [...junk.hit, ...stale.hit];
    return {
      klass: "harmed",
      on: bits.length ? `leftover: ${bits.join("; ")}` : preview(onPacket, c.gold_needles),
      off: offEmpty ? "empty" : preview(offPacket, c.gold_needles),
      delta: offEmpty ? "leftover on only" : "on ≠ off",
      notes: notes.join("; ") || "on-arm leftover",
    };
  }

  if (goldOk && junkOk && staleOk && goldOff.hit.length === 0) {
    const onLabel = [`gold: ${gold.hit.join("; ")}`];
    if (c.stale_needles.length) onLabel.push(`${c.stale_needles.join("; ")} absent`);
    if (c.keep_needles.length && keep.hit.length) onLabel.push(`${keep.hit.join("; ")} kept`);
    if (c.junk_needles.length) onLabel.push("chatter absent");
    return {
      klass: "helped",
      on: onLabel.join("; "),
      off: offEmpty ? "empty" : preview(offPacket, c.gold_needles),
      delta: "needles on only",
      notes: notes.filter((n) => !n.startsWith("LOSS")).join("; ") || "gold on, absent off",
    };
  }

  if ((onEmpty && offEmpty) || same) {
    if (onEmpty) notes.push("inject empty both arms");
    else notes.push("same packet both arms");
    return {
      klass: "no-lift",
      on: onEmpty ? "empty" : preview(onPacket, c.gold_needles),
      off: offEmpty ? "empty" : preview(offPacket, c.gold_needles),
      delta: "0",
      notes: notes.join("; ") || "Δ≈0",
    };
  }

  notes.push("LOSS: on packet is not a gold hit");
  return {
    klass: "no-lift",
    on: preview(onPacket, c.gold_needles),
    off: offEmpty ? "empty" : preview(offPacket, c.gold_needles),
    delta: "on ≠ off",
    notes: notes.join("; "),
  };
}

async function runHost(c: HelpCase, host: Host): Promise<HelpRow> {
  const root = mkdtempSync(join(tmpdir(), `eden-m47-${host}-${c.id}-`));
  const memDir = join(root, "memory");
  try {
    await withEnv(armEnv("on", root, memDir), async () => {
      assertProtocol();
      if (host === "hook") await seedHook(c, memDir);
      else seedWrap(c, memDir);
    });
    const store_n = countJsonl(memDir);
    const onClone = cloneStore(memDir);
    const offClone = cloneStore(memDir);
    let live = "";
    if (c.kind === "omit") {
      const liveClone = cloneStore(memDir);
      const livePacket = await withEnv(armEnv("on", liveClone.home, liveClone.mem), async () => {
        assertProtocol();
        return host === "hook" ? probeHook(c, LIVE_CUE) : probeWrap(c, liveClone.mem, LIVE_CUE);
      });
      const hit = /sqlite/i.test(livePacket);
      live = hit
        ? `store live: “${LIVE_CUE}” injected sqlite`
        : `store dead: “${LIVE_CUE}” missed sqlite (jsonl ${store_n})`;
      rmSync(liveClone.home, { recursive: true, force: true });
    }
    const onPacket = await withEnv(armEnv("on", onClone.home, onClone.mem), async () => {
      assertProtocol();
      return host === "hook" ? probeHook(c, c.cue) : probeWrap(c, onClone.mem, c.cue);
    });
    const offPacket = await withEnv(armEnv("off", offClone.home, offClone.mem), async () => {
      return host === "hook" ? probeHook(c, c.cue) : probeWrap(c, offClone.mem, c.cue);
    });
    rmSync(onClone.home, { recursive: true, force: true });
    rmSync(offClone.home, { recursive: true, force: true });
    const scored = classify(c, onPacket, offPacket, live);
    const gold = hitsIn(onPacket, c.gold_needles);
    return {
      id: c.id,
      host,
      klass: scored.klass,
      on: scored.on,
      off: scored.off,
      delta: scored.delta,
      control: "EDEN_MEMORY=0",
      notes: scored.notes,
      on_packet: onPacket,
      off_packet: offPacket,
      gold_on: gold.hit,
      gold_miss: gold.miss,
      store_n,
      live,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runHelp(): Promise<HelpRun> {
  const cases = [...casesFromHoldout(), silentMath()];
  const rows: HelpRow[] = [];
  for (const c of cases) {
    rows.push(await runHost(c, "wrap"));
    rows.push(await runHost(c, "hook"));
  }
  return {
    date: new Date().toISOString().slice(0, 10),
    bun: Bun.version,
    k: memoryRetrieveCap(),
    rows,
    helped: rows.filter((r) => r.klass === "helped").length,
    no_lift: rows.filter((r) => r.klass === "no-lift").length,
    harmed: rows.filter((r) => r.klass === "harmed").length,
  };
}

export function formatHelp(run: HelpRun): string {
  const lines = [
    "# M47.1 Product help ledger",
    "",
    `**Date:** ${run.date}`,
    `**Bun:** ${run.bun}`,
    "**Report:** §11.2 — MemoryBench humility (memory can help, no-lift, or harm). This file is the live wrap+hook product ledger. `SAVINGS.md` is the M35 bench annex.",
    "**API:** wrap `injectBody` (`openMemory({ dir }).injectBody`) and hook `memoryHookResponse` / `respondToHook` (`openMemory` inject). Not BrainMemory. Not `memory_search`.",
    `**k:** product default (\`EDEN_MEMORY_CAP\` unset → ${run.k}). Not k=40. Not hay. Not LoCoMo 92.`,
    "**No-memory control:** `EDEN_MEMORY=0` (off = inject identity). On arm: `EDEN_MEMORY` unset. `EDEN_KNOW=0` so the Know catalog is not this packet.",
    "",
    `**Totals:** helped ${run.helped} / no-lift ${run.no_lift} / harmed ${run.harmed}`,
    "",
    "Counted rows are host × case, on vs off. Harmed is a count, not a target. Correct omit (silent-math, both packets empty) is no-lift. Ranker not retuned. Fail-open stays. Token Δ is not in this file.",
    "Verdict: helped = WIN. harmed = LOSS. no-lift is junk-silent, not a LOSS.",
    "",
    "## Counted (on vs off)",
    "",
    `Measured ${run.date}. Each row is one scripted live-shaped session. Wrap seeds with \`openMemory({ dir }).observe\`, then scores \`injectBody\`. Hook seeds and cues with \`respondToHook\` → \`memoryHookResponse\` UserPromptSubmit. Off is a clone of that seeded store under \`EDEN_MEMORY=0\`. Hook echoes one packet on both \`additional_context\` and \`hookSpecificOutput.additionalContext\`; this ledger scores that text once.`,
    "",
    "| case | host | class | on | off | Δ | control | notes |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of run.rows) {
    lines.push(
      `| ${mdCell(r.id)} | ${r.host} | ${r.klass} | ${mdCell(r.on)} | ${mdCell(r.off)} | ${mdCell(r.delta)} | ${r.control} | ${mdCell(r.notes)} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict (dated)");
  lines.push("");
  lines.push(`Measured ${run.date}. One WIN or LOSS (or no-lift) per counted case.`);
  lines.push("");
  lines.push("| case | host | verdict |");
  lines.push("|---|---|---|");
  for (const r of run.rows) {
    const verdict = r.klass === "helped" ? "WIN" : r.klass === "harmed" ? "LOSS" : "no-lift";
    lines.push(`| ${mdCell(r.id)} | ${r.host} | ${verdict} |`);
  }
  lines.push("");
  lines.push("## Packets (audit)");
  lines.push("");
  lines.push("System text containing `Eden Memory:` only. Empty means the product returned inject identity (no mark).");
  lines.push("");
  for (const r of run.rows) {
    lines.push(
      `- **${r.id} / ${r.host}** jsonl ${r.store_n} — on: ${r.on_packet ? mdCell(r.on_packet) : "empty"} — off: ${r.off_packet ? mdCell(r.off_packet) : "empty"}`,
    );
  }
  lines.push("");
  lines.push("## Construction traps");
  lines.push("");
  lines.push("Not helped rows:");
  lines.push("");
  lines.push("- Memorable 454/454 is a fixture-completion score, not this inject exam.");
  lines.push("- Mem0 92 (LoCoMo 92) is not an Eden on-vs-off result.");
  lines.push("");
  lines.push(
    "No BrainMemory column. No cortex-off column. No k=40. No hay. No `memory_search`. Fail-open and silent inject stay as they are.",
  );
  lines.push("");
  lines.push("## Not in this file");
  lines.push("");
  lines.push("- Token Δ lives in `HELP-TOKENS.md` (M47.3). This ledger does not invent token numbers.");
  lines.push(
    "- Harmed ids omitted on the next inject is M47.2 product code (`src/memory-harmed.ts`). This file only classifies sessions.",
  );
  lines.push("");
  lines.push("## How to re-run");
  lines.push("");
  lines.push("```bash");
  lines.push("bun benchmarks/memory-holdout/run-help.ts");
  lines.push("```");
  lines.push("");
  lines.push("Writes this file from the run. Does not retune `src/index.ts`. Does not edit `SAVINGS.md`.");
  lines.push("");
  return lines.join("\n");
}

export function writeHelp(run: HelpRun, path = HELP_PATH): string {
  const md = formatHelp(run);
  writeFileSync(path, md);
  return md;
}

if (import.meta.main) {
  const run = await runHelp();
  const md = writeHelp(run);
  process.stdout.write(md);
  process.stdout.write(`\n totals helped ${run.helped} / no-lift ${run.no_lift} / harmed ${run.harmed}\n`);
}
