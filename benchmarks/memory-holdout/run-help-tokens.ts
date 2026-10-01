/**
 * M47.3 wrap token Δ (injectBody).
 *
 *   bun benchmarks/memory-holdout/run-help-tokens.ts
 *
 * Scored API: openMemory.injectBody (OpenAI messages body). Not BrainMemory.
 * Not memory_search. Not hook-inject. k default (EDEN_MEMORY_CAP unset → 6).
 * Off is EDEN_MEMORY=0. On is EDEN_MEMORY unset. EDEN_KNOW=0.
 *
 * Cue classes: holdout observe prompts (flake, adr, file-rule, version, junk)
 * plus silence sqlite+Clerk seed on a math cue (silent-math).
 * Packet bytes are the UTF-8 length of system content containing "Eden Memory:".
 * Approx tokens are ceil(chars/4) of that packet. Ranker is not retuned.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, memoryConsent, memoryRetrieveCap, openMemory, type AgentMemory } from "../../src/index.ts";

export const HOLD_DIR = import.meta.dir;
export const HELP_TOKENS_PATH = join(HOLD_DIR, "HELP-TOKENS.md");
export const HOLDOUT_FIXTURE = join(HOLD_DIR, "holdout-fixture.json");
export const SILENCE_FIXTURE = join(HOLD_DIR, "silence-fixture.json");

const CUE_IDS = ["flake", "adr", "file-rule", "version", "junk", "silent-math"] as const;

type Arm = "on" | "off";

type CueCase = {
  id: (typeof CUE_IDS)[number];
  cue: string;
  gold: string[];
  leftover: string[];
  seed: (mem: AgentMemory) => void;
};

type Probe = {
  arm: Arm;
  identity: boolean;
  omitted: boolean;
  bytes: number;
  chars: number;
  tokens: number;
  text: string;
  gold_hits: string[];
  leftover_hits: string[];
};

type Row = {
  id: string;
  cue: string;
  store_n: number;
  off: Probe;
  on: Probe;
  delta_bytes: number;
  accuracy_delta: number;
  silent: boolean;
  must_be_silent: boolean;
  verdict: string;
  anth_bytes: number;
  anth_agrees: boolean;
};

type Run = {
  date: string;
  bun: string;
  k: number;
  rows: Row[];
  sum_delta_bytes: number;
  tokens_up_no_lift: number;
};

const junk: string[] = [];

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function envFor(arm: Arm): Record<string, string | undefined> {
  return {
    EDEN_MEMORY: arm === "off" ? "0" : undefined,
    EDEN_MEMORY_DIR: undefined,
    EDEN_HOME: undefined,
    EDEN_MEMORY_CAP: undefined,
    EDEN_MEMORY_MIN: undefined,
    EDEN_MEMORY_AGENT: undefined,
    EDEN_MEMORY_PROJECT: undefined,
    EDEN_MEMORY_SESSION: undefined,
    EDEN_MEMORY_SWALLOW: undefined,
    EDEN_KNOW: "0",
  };
}

function assertProtocol(): void {
  if (process.env.EDEN_MEMORY_CAP) throw new Error("EDEN_MEMORY_CAP must be unset (k default, not 40)");
  const k = memoryRetrieveCap();
  if (k !== 6) throw new Error(`memoryRetrieveCap ${k} !== 6`);
}

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-m473-"));
  junk.push(dir);
  return dir;
}

function cloneDir(src: string): string {
  const dest = join(freshDir(), "store");
  cpSync(src, dest, { recursive: true });
  return dest;
}

function systemTexts(list: unknown[]): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const role = String((m as { role?: unknown }).role ?? "");
    const content = (m as { content?: unknown }).content;
    if (role === "system" && typeof content === "string") out.push(content);
  }
  return out;
}

function memoryPacket(list: unknown[]): string {
  return systemTexts(list)
    .filter((s) => s.includes(MEMORY_MARK))
    .join("\n");
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function approxTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

function hits(text: string, needles: string[]): string[] {
  const hay = text.toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
}

function messagesFor(cue: string): { role: string; content: string }[] {
  return [{ role: "user", content: cue }];
}

function loadCases(): CueCase[] {
  const holdout = JSON.parse(readFileSync(HOLDOUT_FIXTURE, "utf8")) as {
    cases: {
      id: string;
      observe: { prompt?: string }[];
      cue: { prompt?: string };
      gold_needles: string[];
      junk_needles?: string[];
    }[];
  };
  const silence = JSON.parse(readFileSync(SILENCE_FIXTURE, "utf8")) as {
    cases: { id: string; seed?: string[]; cue: string; leftover_needles?: string[] }[];
  };
  const byId = new Map(holdout.cases.map((c) => [c.id, c]));
  const math = silence.cases.find((c) => c.id === "seeded-math");
  if (!math?.seed?.length || !math.cue) throw new Error("silence seeded-math missing");
  const cases: CueCase[] = [];
  for (const id of ["flake", "adr", "file-rule", "version", "junk"] as const) {
    const c = byId.get(id);
    if (!c?.cue?.prompt) throw new Error(`holdout case ${id} missing`);
    const prompts = c.observe.map((e) => String(e.prompt ?? "")).filter(Boolean);
    if (!prompts.length) throw new Error(`${id}: observe prompts empty`);
    cases.push({
      id,
      cue: c.cue.prompt,
      gold: c.gold_needles,
      leftover: c.junk_needles ?? [],
      seed: (mem) => {
        for (const prompt of prompts) mem.observe([{ role: "user", content: prompt }]);
      },
    });
  }
  cases.push({
    id: "silent-math",
    cue: math.cue,
    gold: [],
    leftover: math.leftover_needles ?? ["sqlite", "Clerk"],
    seed: (mem) => {
      for (const fact of math.seed!) mem.remember(fact);
    },
  });
  return cases;
}

function seedDir(c: CueCase): string {
  const dir = freshDir();
  withEnv(envFor("on"), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    c.seed(mem);
    mem.close();
  });
  return dir;
}

function storeCount(dir: string): number {
  return withEnv(envFor("on"), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    try {
      return mem.memories().length;
    } finally {
      mem.close();
    }
  });
}

function probeBody(dir: string, arm: Arm, c: CueCase): Probe {
  return withEnv(envFor(arm), () => {
    assertProtocol();
    if (arm === "off" && memoryConsent() !== "off") throw new Error(`off consent ${memoryConsent()} !== off`);
    if (arm === "on" && memoryConsent() !== "on") throw new Error(`on consent ${memoryConsent()} !== on`);
    const mem = openMemory({ dir });
    const messages = messagesFor(c.cue);
    const body = { messages };
    const out = mem.injectBody(body);
    mem.close();
    const list =
      out && typeof out === "object" && Array.isArray((out as { messages?: unknown[] }).messages)
        ? (out as { messages: unknown[] }).messages
        : [];
    const text = memoryPacket(list);
    const identity = out === body;
    const bytes = byteLen(text);
    const omitted = identity && bytes === 0 && !text.includes(MEMORY_MARK);
    return {
      arm,
      identity,
      omitted,
      bytes,
      chars: text.length,
      tokens: approxTokens(text.length),
      text,
      gold_hits: hits(text, c.gold),
      leftover_hits: hits(text, c.leftover),
    };
  });
}

/** Anthropic wrap copies inject() system packets. Same messages, not a second product score. */
function probeInject(dir: string, cue: string): number {
  return withEnv(envFor("on"), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    const messages = messagesFor(cue);
    const out = mem.inject(messages);
    mem.close();
    return byteLen(memoryPacket(Array.isArray(out) ? out : []));
  });
}

function judge(
  off: Probe,
  on: Probe,
): { accuracy_delta: number; silent: boolean; must_be_silent: boolean; verdict: string } {
  const accuracy_delta = on.gold_hits.length - off.gold_hits.length;
  const silent = on.omitted && on.bytes === 0;
  const tokens_up = on.tokens > off.tokens;
  const must_be_silent = tokens_up && accuracy_delta <= 0;
  let verdict = "no-lift";
  if (must_be_silent) verdict = "must-be-silent";
  else if (accuracy_delta > 0) verdict = "helped";
  else if (silent && off.bytes === 0) verdict = "silent";
  else if (off.bytes !== 0) verdict = "off-not-identity";
  return { accuracy_delta, silent, must_be_silent, verdict };
}

export function runHelpTokens(opts: { write?: boolean } = {}): Run {
  const cases = loadCases();
  const ids = cases.map((c) => c.id);
  for (const id of CUE_IDS) if (!ids.includes(id)) throw new Error(`missing cue class ${id}`);
  const rows: Row[] = [];
  try {
    for (const c of cases) {
      const template = seedDir(c);
      const store_n = storeCount(template);
      const off = probeBody(cloneDir(template), "off", c);
      const on = probeBody(cloneDir(template), "on", c);
      const anth_bytes = probeInject(cloneDir(template), c.cue);
      const judged = judge(off, on);
      rows.push({
        id: c.id,
        cue: c.cue,
        store_n,
        off,
        on,
        delta_bytes: on.bytes - off.bytes,
        anth_bytes,
        anth_agrees: anth_bytes === on.bytes,
        ...judged,
      });
    }
  } finally {
    for (const dir of junk.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
  const run: Run = {
    date: new Date().toISOString().slice(0, 10),
    bun: typeof Bun !== "undefined" ? Bun.version : "unknown",
    k: 6,
    rows,
    sum_delta_bytes: rows.reduce((n, r) => n + r.delta_bytes, 0),
    tokens_up_no_lift: rows.filter((r) => r.must_be_silent).length,
  };
  if (opts.write !== false) writeFileSync(HELP_TOKENS_PATH, formatHelpTokens(run));
  return run;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

export function formatHelpTokens(run: Run): string {
  const table = run.rows
    .map((r) => {
      const acc = r.accuracy_delta > 0 ? `+${r.accuracy_delta}` : String(r.accuracy_delta);
      return `| ${r.id} | ${r.off.tokens} | ${r.on.tokens} | ${r.off.bytes} | ${r.on.bytes} | ${r.delta_bytes} | ${acc} | ${yn(r.silent)} | ${r.verdict} |`;
    })
    .join("\n");
  const flagged = run.rows.filter((r) => r.must_be_silent);
  const flagNote = flagged.length
    ? flagged
        .map(
          (r) =>
            `- **${r.id}:** tokens ${r.off.tokens} → ${r.on.tokens}, accuracy Δ ${r.accuracy_delta}, bytes Δ ${r.delta_bytes}. This cue class is silent (M38). Ranker was not retuned.`,
        )
        .join("\n")
    : "- None. No cue class had tokens up and accuracy Δ≤0.";
  const packets = run.rows
    .map((r) => {
      const gold = r.on.gold_hits.length ? r.on.gold_hits.join(", ") : "none";
      const left = r.on.leftover_hits.length ? r.on.leftover_hits.join(", ") : "none";
      return [
        `### ${r.id}`,
        `- cue: \`${cell(r.cue)}\``,
        `- store_n: ${r.store_n}`,
        `- gold on-arm: ${cell(gold)}`,
        `- leftover on-arm: ${cell(left)}`,
        `- inject() bytes (Anthropic message source): ${r.anth_bytes} · agrees with injectBody: ${yn(r.anth_agrees)}`,
        `- on packet: ${cell(preview(r.on.text))}`,
      ].join("\n");
    })
    .join("\n\n");
  const anthAll = run.rows.every((r) => r.anth_agrees);
  return [
    "# M47.3 Wrap token Δ",
    "",
    `**Date:** ${run.date}`,
    "**API:** wrap `injectBody` / `openMemory`. Not BrainMemory. Not memory_search.",
    "**Control:** `EDEN_MEMORY=0` (off, inject identity). **On:** `EDEN_MEMORY` unset.",
    "**Know:** `EDEN_KNOW=0`.",
    `**k:** default (EDEN_MEMORY_CAP unset → ${run.k}). No k=40. No hay. No LoCoMo 92.`,
    `**Bun:** ${run.bun}`,
    "",
    "This file is wrap inject packet tokens only. LIVE session classification is HELP.md (M47.1). Harbor/TB totals are not this number.",
    "",
    "Approx tokens are `ceil(chars/4)` of the system content that contains `Eden Memory:`. Bytes are the UTF-8 length of that packet. Off is 0 bytes when identity. Accuracy Δ is gold needles present on the on-arm minus gold needles on the off-arm. Gold on-arm only and off empty is Δ>0 (helped). Both empty of gold is Δ=0. On-arm leftover junk on math with tokens up is Δ≤0 and that class is silent (M38).",
    "",
    "## Table",
    "",
    "| case | tokens_off (approx) | tokens_on | bytes_off | bytes_on | Δ bytes | accuracy Δ (needles) | silent? | verdict |",
    "|---|---|---|---|---|---|---|---|---|",
    table,
    "",
    "## Totals",
    "",
    `- **sum Δ bytes:** ${run.sum_delta_bytes}`,
    `- **classes where tokens up and accuracy Δ≤0:** ${run.tokens_up_no_lift} (target 0)`,
    "",
    "## Classes that must be silent",
    "",
    flagNote,
    "",
    "## Anthropic-shaped check",
    "",
    "`inject` via the same user messages is the packet source Anthropic wrap copies into `system`. It is not a second scored API. `injectBody` is the wrap OpenAI path and the filed number.",
    "",
    anthAll
      ? "- inject() packet bytes matched injectBody on every class."
      : "- inject() packet bytes disagreed with injectBody on at least one class. Filed numbers stay injectBody.",
    "",
    "## Packets",
    "",
    packets,
    "",
    "## How to re-run",
    "",
    "```bash",
    "bun benchmarks/memory-holdout/run-help-tokens.ts",
    "```",
    "",
    "Writes this file from the run. Does not retune the ranker. Does not edit holdout or silence fixtures.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const run = runHelpTokens();
  process.stdout.write(formatHelpTokens(run));
  const summary = run.rows
    .map(
      (r) =>
        `${r.id}\t${r.verdict}\toff ${r.off.tokens}/${r.off.bytes}B\ton ${r.on.tokens}/${r.on.bytes}B\tΔB ${r.delta_bytes}\tacc ${r.accuracy_delta}\tsilent ${r.silent ? "yes" : "no"}`,
    )
    .join("\n");
  console.error(
    `\n${summary}\nsum Δ bytes ${run.sum_delta_bytes}\ntokens-up and accuracy Δ≤0: ${run.tokens_up_no_lift}`,
  );
}
