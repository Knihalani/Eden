/**
 * M35.1 no-lift annex (inject path).
 *
 *   bun benchmarks/memory-holdout/run-negative.ts
 *
 * Pre-registered expects live in negative-fixture.json (ROADMAP §4.9).
 * This file measures openMemory.inject / injectBody. Run as above, it rewrites the
 * tracked NEGATIVE.md; runNegative() itself writes a report only to the `out` it is
 * given, so the tests render into a temp dir and leave the tree clean.
 * It does not edit the fixture, the ranker, or remain-silent (M38).
 *
 * Scored API: openMemory.inject. injectBody is the same AgentMemory path, checked
 * beside inject. hook-inject is named and not scored (dual-API forbidden).
 * k = product default (EDEN_MEMORY_CAP unset → 6). No hay. No BrainMemory.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, memoryRetrieveCap, openMemory } from "../../src/index.ts";
import { memoryConsent } from "../../src/memory-consent.ts";

export const HOLD_DIR = import.meta.dir;
export const FIXTURE_PATH = join(HOLD_DIR, "negative-fixture.json");
export const NEGATIVE_PATH = join(HOLD_DIR, "NEGATIVE.md");

export const REQUIRED_CASE_IDS = ["empty-math", "aa-off", "seeded-math", "seeded-openssl", "empty-coding"] as const;

type Arm = "on" | "off";

export type NegativeCase = {
  id: string;
  title: string;
  store: "empty" | "sqlite-clerk";
  seed?: string[];
  leftover_needles?: string[];
  cue: string;
  arms: Arm[];
  expect: "DELTA_ZERO" | "MEASURE";
  expect_note: string;
};

export type NegativeFixture = {
  id: string;
  schema: number;
  part: string;
  dated_registered: string;
  api_under_test: string;
  product: string[];
  named_not_scored: string[];
  k: string;
  k_default: number;
  materiality: number;
  know: string;
  off: string;
  on: string;
  delta_def: string;
  seed_liveness: { cue: string; needle: string; role: string };
  bans: string[];
  cases: NegativeCase[];
};

export type Probe = {
  arm: Arm;
  consent: string;
  k: number;
  identity: boolean;
  packet_bytes: number;
  packet_text: string;
  added_system_bytes: number;
  wall_ms: number;
  body_identity: boolean;
  body_packet_bytes: number;
  body_packet_text: string;
  body_agrees: boolean;
};

export type NegativeRow = {
  id: string;
  title: string;
  expect: NegativeCase["expect"];
  expect_note: string;
  cue: string;
  store_n: number;
  seed_ok: boolean;
  baseline: Probe;
  probe: Probe;
  delta_bytes: number;
  body_delta_bytes: number;
  band_bytes: number;
  delta_approx_0: boolean;
  leftover: string[];
  body_leftover: string[];
  seed_live: boolean;
  verdict: "Δ≈0" | "LOSS" | "FAIL";
  note: string;
};

export type SeedLiveness = {
  cue: string;
  packet_bytes: number;
  sqlite: boolean;
  preview: string;
};

export type NegativeRun = {
  date: string;
  registered: string;
  bun: string;
  api_under_test: string;
  k: string;
  materiality: number;
  rows: NegativeRow[];
  bugs: string[];
  seed_liveness: SeedLiveness;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadNegativeFixture(path = FIXTURE_PATH): NegativeFixture {
  return JSON.parse(readFileSync(path, "utf8")) as NegativeFixture;
}

export function negativeFixtureIssues(fix: NegativeFixture): string[] {
  const issues: string[] = [];
  if (fix.schema !== 1) issues.push(`schema ${fix.schema} !== 1`);
  if (fix.part !== "M35.1") issues.push(`part ${fix.part} !== M35.1`);
  if (!ISO_DATE.test(fix.dated_registered ?? "")) issues.push("dated_registered must be YYYY-MM-DD");
  if (fix.api_under_test !== "openMemory.inject")
    issues.push(`api_under_test ${fix.api_under_test} !== openMemory.inject`);
  if (fix.k !== "default") issues.push(`k ${fix.k} !== default`);
  if (fix.k_default !== 6) issues.push(`k_default ${fix.k_default} !== 6`);
  if (fix.materiality !== 0.01) issues.push(`materiality ${fix.materiality} !== 0.01 (ROADMAP §4.9; do not retune)`);
  if (fix.know !== "EDEN_KNOW=0") issues.push("know must stay EDEN_KNOW=0");
  if (!fix.seed_liveness?.cue?.trim() || fix.seed_liveness.needle !== "sqlite")
    issues.push("seed_liveness must be a sqlite setup cue, not a scored row");
  if (fix.off !== "EDEN_MEMORY=0") issues.push("off must stay EDEN_MEMORY=0");
  const product = fix.product ?? [];
  for (const name of ["openMemory", "inject", "injectBody"]) {
    if (!product.includes(name)) issues.push(`product missing ${name}`);
  }
  if (!(fix.named_not_scored ?? []).includes("hook-inject")) issues.push("hook-inject must be named and not scored");
  const ids = new Set((fix.cases ?? []).map((c) => c.id));
  for (const id of REQUIRED_CASE_IDS) if (!ids.has(id)) issues.push(`missing case ${id}`);
  for (const c of fix.cases ?? []) {
    const raw = c as NegativeCase & Record<string, unknown>;
    if ("verdict" in raw || "delta_bytes" in raw || "packet_bytes" in raw)
      issues.push(`${c.id}: fixture must not hold measured fields`);
    if (c.expect !== "DELTA_ZERO" && c.expect !== "MEASURE")
      issues.push(`${c.id}: expect ${c.expect} not DELTA_ZERO|MEASURE`);
    if (!c.cue?.trim()) issues.push(`${c.id}: cue empty`);
    if (!Array.isArray(c.arms) || c.arms.length !== 2) issues.push(`${c.id}: arms must be a pair`);
    else if (c.arms.some((a) => a !== "on" && a !== "off")) issues.push(`${c.id}: arm not on|off`);
    if (c.store === "sqlite-clerk") {
      const seed = c.seed ?? [];
      if (!seed.some((s) => /sqlite/i.test(s)) || !seed.some((s) => /Clerk/.test(s)))
        issues.push(`${c.id}: seed must include sqlite and Clerk`);
      if (!(c.leftover_needles ?? []).includes("sqlite") || !(c.leftover_needles ?? []).includes("Clerk"))
        issues.push(`${c.id}: leftover needles must name sqlite and Clerk`);
    } else if (c.store !== "empty") issues.push(`${c.id}: store ${c.store} not empty|sqlite-clerk`);
    if ((c.id === "empty-math" || c.id === "aa-off" || c.id === "empty-coding") && c.expect !== "DELTA_ZERO") {
      issues.push(`${c.id}: pre-registered expect must stay DELTA_ZERO`);
    }
    if ((c.id === "seeded-math" || c.id === "seeded-openssl") && c.expect !== "MEASURE") {
      issues.push(`${c.id}: pre-registered expect must stay MEASURE`);
    }
  }
  return issues;
}

/** ±1% band. Baseline 0 → 0.01 byte, so only Δ = 0 counts as Δ≈0. */
export function withinBand(baseline: number, probe: number, materiality = 0.01): boolean {
  const band = materiality * Math.max(baseline, 1);
  return Math.abs(probe - baseline) <= band;
}

export function bandBytes(baseline: number, materiality = 0.01): number {
  return materiality * Math.max(baseline, 1);
}

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
    EDEN_MEMORY_AGENT: undefined,
    EDEN_MEMORY_PROJECT: undefined,
    EDEN_MEMORY_SWALLOW: undefined,
    EDEN_KNOW: "0",
  };
}

function assertProtocol(): void {
  if (process.env.EDEN_MEMORY_CAP) throw new Error("EDEN_MEMORY_CAP must be unset (k default, not 40)");
  const k = memoryRetrieveCap();
  if (k !== 6) throw new Error(`memoryRetrieveCap ${k} !== 6`);
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

function leftoversOf(text: string, needles: string[]): string[] {
  const blob = text.toLowerCase();
  return needles.filter((n) => blob.includes(n.toLowerCase()));
}

function messagesFor(cue: string): { role: string; content: string }[] {
  return [{ role: "user", content: cue }];
}

function probeSeed(dir: string, cue: string, needle: string): { bytes: number; hit: boolean; text: string } {
  return withEnv(envFor("on"), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    const messages = messagesFor(cue);
    const out = mem.inject(messages);
    mem.close();
    const text = memoryPacket(Array.isArray(out) ? out : []);
    return { bytes: byteLen(text), hit: text.toLowerCase().includes(needle.toLowerCase()), text };
  });
}

function probeArm(dir: string, arm: Arm, cue: string, needles: string[]): Probe {
  // Snapshot before inject: observe() may write the cue after the packet is built.
  const bodyDir = cloneDir(dir);
  const injectProbe = withEnv(envFor(arm), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    const messages = messagesFor(cue);
    const t0 = performance.now();
    const out = mem.inject(messages);
    const wall_ms = performance.now() - t0;
    mem.close();
    const list = Array.isArray(out) ? out : [];
    const packet = memoryPacket(list);
    const added = systemTexts(list).join("\n");
    return {
      consent: memoryConsent(),
      k: memoryRetrieveCap(),
      identity: out === messages,
      packet_bytes: byteLen(packet),
      packet_text: packet,
      added_system_bytes: byteLen(added),
      wall_ms,
    };
  });
  const bodyProbe = withEnv(envFor(arm), () => {
    assertProtocol();
    const mem = openMemory({ dir: bodyDir });
    const messages = messagesFor(cue);
    const body = { model: "gpt-4o", messages };
    const out = mem.injectBody(body);
    mem.close();
    const list =
      out && typeof out === "object" && Array.isArray((out as { messages?: unknown[] }).messages)
        ? (out as { messages: unknown[] }).messages
        : [];
    const packet = memoryPacket(list);
    return {
      body_identity: out === body,
      body_packet_bytes: byteLen(packet),
      body_packet_text: packet,
    };
  });
  const body_agrees =
    bodyProbe.body_identity === injectProbe.identity &&
    bodyProbe.body_packet_bytes === injectProbe.packet_bytes &&
    leftoversOf(bodyProbe.body_packet_text, needles).join("|") ===
      leftoversOf(injectProbe.packet_text, needles).join("|");
  return { arm, ...injectProbe, ...bodyProbe, body_agrees };
}

const junk: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-m35-"));
  junk.push(dir);
  return dir;
}

function cloneDir(src: string): string {
  const dest = join(freshDir(), "store");
  cpSync(src, dest, { recursive: true });
  return dest;
}

function seedDir(facts: string[]): string {
  const dir = freshDir();
  withEnv(envFor("on"), () => {
    assertProtocol();
    const mem = openMemory({ dir });
    for (const fact of facts) mem.remember(fact);
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

function localDate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function judge(row: Omit<NegativeRow, "verdict" | "note"> & { seed_expected: number; store: string }): {
  verdict: NegativeRow["verdict"];
  note: string;
} {
  const notes: string[] = [];
  if (row.store !== "empty" && !row.seed_ok)
    notes.push(`seed store_n ${row.store_n} < ${row.seed_expected}; refusing a no-lift claim`);
  if (row.store !== "empty" && !row.seed_live)
    notes.push("related sqlite cue did not inject sqlite; refusing a no-lift claim");
  if (row.baseline.consent !== "off") notes.push(`baseline consent ${row.baseline.consent} !== off`);
  if (row.probe.arm === "on" && row.probe.consent !== "on") notes.push(`probe consent ${row.probe.consent} !== on`);
  if (row.probe.arm === "off" && row.probe.consent !== "off") notes.push(`probe consent ${row.probe.consent} !== off`);
  if (row.baseline.k !== 6 || row.probe.k !== 6) notes.push(`k ${row.baseline.k}/${row.probe.k} !== 6`);
  if (!row.baseline.body_agrees)
    notes.push(
      `injectBody baseline packet ${row.baseline.body_packet_bytes} B identity ` +
        `${row.baseline.body_identity} disagrees with inject ${row.baseline.packet_bytes} B`,
    );
  if (!row.probe.body_agrees)
    notes.push(
      `injectBody probe packet ${row.probe.body_packet_bytes} B identity ${row.probe.body_identity} ` +
        `disagrees with inject ${row.probe.packet_bytes} B`,
    );
  const setupBad = notes.some(
    (n) =>
      n.startsWith("seed") ||
      n.startsWith("related") ||
      n.startsWith("baseline consent") ||
      n.startsWith("probe consent") ||
      n.startsWith("k "),
  );
  const silent =
    row.delta_approx_0 &&
    row.baseline.identity &&
    row.probe.identity &&
    row.baseline.packet_bytes === 0 &&
    row.probe.packet_bytes === 0 &&
    row.leftover.length === 0 &&
    row.baseline.added_system_bytes === 0 &&
    row.probe.added_system_bytes === 0;
  const bodySilent =
    row.baseline.body_identity &&
    row.probe.body_identity &&
    row.baseline.body_packet_bytes === 0 &&
    row.probe.body_packet_bytes === 0 &&
    row.body_leftover.length === 0;
  if (setupBad) return { verdict: "FAIL", note: notes.join("; ") };
  if (silent && bodySilent) return { verdict: "Δ≈0", note: notes.join("; ") };
  if (row.expect === "DELTA_ZERO") {
    notes.push("pre-registered Δ≈0 missed");
    return { verdict: "FAIL", note: notes.join("; ") };
  }
  if (row.leftover.length) notes.push(`leftover in inject packet: ${row.leftover.join(", ")}`);
  if (row.body_leftover.length) notes.push(`leftover in injectBody packet: ${row.body_leftover.join(", ")}`);
  if (!row.delta_approx_0 || row.body_delta_bytes !== 0)
    notes.push(
      `NON-ZERO packet Δ inject ${row.delta_bytes} B / injectBody ${row.body_delta_bytes} B vs ` +
        `remain-silent (omit is M38, not implemented)`,
    );
  if (!row.probe.identity || !row.probe.body_identity) notes.push("probe inject is not identity");
  return { verdict: "LOSS", note: notes.join("; ") };
}

export function runNegative(opts: { out?: string } = {}): NegativeRun {
  const fix = loadNegativeFixture();
  const issues = negativeFixtureIssues(fix);
  if (issues.length) throw new Error("negative fixture:\n" + issues.map((i) => `- ${i}`).join("\n"));
  const bugs: string[] = [];
  const rows: NegativeRow[] = [];
  let seedLiveness: SeedLiveness = { cue: fix.seed_liveness.cue, packet_bytes: 0, sqlite: false, preview: "" };
  try {
    let seeded: { dir: string; n: number; live: boolean } | undefined;
    for (const c of fix.cases) {
      const needles = c.leftover_needles ?? [];
      const seedExpected = c.seed?.length ?? 0;
      let template: string;
      let storeN = 0;
      if (c.store === "sqlite-clerk") {
        if (!seeded) {
          const dir = seedDir(c.seed ?? []);
          const n = storeCount(dir);
          const live = probeSeed(cloneDir(dir), fix.seed_liveness.cue, fix.seed_liveness.needle);
          seedLiveness = {
            cue: fix.seed_liveness.cue,
            packet_bytes: live.bytes,
            sqlite: live.hit,
            preview: preview(live.text),
          };
          seeded = { dir, n, live: live.hit };
        }
        template = seeded.dir;
        storeN = seeded.n;
      } else {
        template = freshDir();
        storeN = storeCount(template);
      }
      const seedOk = c.store === "empty" ? storeN === 0 : storeN >= seedExpected;
      const seedLive = c.store === "empty" ? true : Boolean(seeded?.live);
      const baseline = probeArm(cloneDir(template), c.arms[0]!, c.cue, needles);
      const probe = probeArm(cloneDir(template), c.arms[1]!, c.cue, needles);
      const delta_bytes = probe.packet_bytes - baseline.packet_bytes;
      const body_delta_bytes = probe.body_packet_bytes - baseline.body_packet_bytes;
      const leftover = leftoversOf(probe.packet_text, needles);
      const body_leftover = leftoversOf(probe.body_packet_text, needles);
      const partial = {
        id: c.id,
        title: c.title,
        expect: c.expect,
        expect_note: c.expect_note,
        cue: c.cue,
        store_n: storeN,
        seed_ok: seedOk,
        baseline,
        probe,
        delta_bytes,
        body_delta_bytes,
        band_bytes: bandBytes(baseline.packet_bytes, fix.materiality),
        delta_approx_0: withinBand(baseline.packet_bytes, probe.packet_bytes, fix.materiality),
        leftover,
        body_leftover,
        seed_live: seedLive,
      };
      const judged = judge({ ...partial, seed_expected: seedExpected, store: c.store });
      rows.push({ ...partial, ...judged });
      if (!baseline.body_agrees)
        bugs.push(
          `${c.id} baseline: injectBody packet ${baseline.body_packet_bytes} B / identity ` +
            `${baseline.body_identity} vs inject ${baseline.packet_bytes} B / identity ${baseline.identity}`,
        );
      if (!probe.body_agrees)
        bugs.push(
          `${c.id} probe: injectBody packet ${probe.body_packet_bytes} B / identity ${probe.body_identity} vs ` +
            `inject ${probe.packet_bytes} B / identity ${probe.identity}`,
        );
      if (body_leftover.length && leftover.join("|") !== body_leftover.join("|")) {
        bugs.push(
          `${c.id}: injectBody leftover [${body_leftover.join(", ")}] vs inject leftover [${leftover.join(", ")}]`,
        );
      }
    }
  } finally {
    for (const dir of junk.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
  const run: NegativeRun = {
    date: localDate(),
    registered: fix.dated_registered,
    bun: typeof Bun !== "undefined" ? Bun.version : "unknown",
    api_under_test: fix.api_under_test,
    k: `default (EDEN_MEMORY_CAP unset → ${fix.k_default})`,
    materiality: fix.materiality,
    rows,
    bugs,
    seed_liveness: seedLiveness,
  };
  if (opts.out) writeFileSync(opts.out, formatNegative(run));
  return run;
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

export function formatNegative(run: NegativeRun): string {
  const byId = (id: string) => run.rows.find((r) => r.id === id);
  const line = (r: NegativeRow | undefined) =>
    r ? `${r.baseline.packet_bytes} B → ${r.probe.packet_bytes} B, Δ ${r.delta_bytes} B, ${r.verdict}` : "missing";
  const rows = run.rows
    .map(
      (r) =>
        `| ${r.id} | ${r.expect} | ${r.baseline.arm} | ${r.probe.arm} | ${r.store_n} ` +
        `| ${r.baseline.packet_bytes} | ${r.probe.packet_bytes} | ${r.delta_bytes} | ${r.band_bytes} ` +
        `| ${yn(r.delta_approx_0)} | ${r.leftover.length ? cell(r.leftover.join(", ")) : "—"} ` +
        `| ${yn(r.baseline.identity)}/${yn(r.probe.identity)} | ${r.baseline.body_packet_bytes} ` +
        `| ${r.probe.body_packet_bytes} | ${r.verdict} |`,
    )
    .join("\n");
  const notes = run.rows
    .filter((r) => r.note)
    .map((r) => `- **${r.id}:** ${cell(r.note)}`)
    .join("\n");
  const packets = run.rows
    .filter((r) => r.probe.packet_text || r.baseline.packet_text)
    .map((r) => {
      const parts = [`### ${r.id}`];
      if (r.baseline.packet_text) parts.push(`- baseline: ${cell(preview(r.baseline.packet_text))}`);
      if (r.probe.packet_text) parts.push(`- probe: ${cell(preview(r.probe.packet_text))}`);
      return parts.join("\n");
    })
    .join("\n\n");
  const aa = byId("aa-off");
  const wall = aa ? (aa.probe.wall_ms - aa.baseline.wall_ms).toFixed(3) : "n/a";
  const bugs = run.bugs.length
    ? run.bugs.map((b) => `- ${cell(b)}`).join("\n")
    : "- None on this run. injectBody packet bytes and identity matched inject on every arm.";
  return [
    "# M35.1 No-lift NEGATIVE",
    "",
    `**Date:** ${run.date}`,
    `**Pre-registered:** ${run.registered} (\`negative-fixture.json\`, ROADMAP §4.9). Expects were not ` +
      `edited after this run.`,
    `**Bun:** ${run.bun}`,
    "**Part:** M35.1",
    `**API under test:** inject path (\`openMemory\` / \`inject\`). \`injectBody\` is the same ` +
      `\`openMemory\` path, checked in the table and not a second product.`,
    "**hook-inject:** named, not scored. Gate 1 hook-inject is `RESULTS.md`. Dual-API forbidden.",
    `**k:** ${run.k}`,
    `**Materiality:** ±${run.materiality * 100}% (band = materiality × max(baseline bytes, 1)). ` +
      `Baseline 0 ⇒ band 0.01 byte ⇒ only Δ = 0 is Δ≈0.`,
    "**Off:** `EDEN_MEMORY=0` (inject identity). **On:** `EDEN_MEMORY` unset (product default).",
    "**Know:** `EDEN_KNOW=0` so the Know catalog is not this memory packet.",
    "",
    "No BrainMemory column. Inject path only. k default. No hay. No k=40. LoCoMo 92 is not an Eden " +
      "claim. Ranker not tuned. Dual-API forbidden. Fail-open stays. Silent inject stays. No " +
      "`memory_search`. Remain-silent omit is M38 (not implemented). Live wrap+hook HELP.md is M47 (not " +
      "created).",
    "",
    "## Key numbers",
    "",
    `- **empty-math (Done-when cell):** ${line(byId("empty-math"))}`,
    `- **aa-off (noise floor):** ${line(byId("aa-off"))}`,
    `- **seeded-math:** ${line(byId("seeded-math"))}`,
    `- **seeded-openssl:** ${line(byId("seeded-openssl"))}`,
    `- **empty-coding:** ${line(byId("empty-coding"))}`,
    "",
    "## On vs off Δ table",
    "",
    "Scored bytes are the UTF-8 length of system content containing `Eden Memory:`. Δ = probe − " +
      "baseline. `injectBody B` is the same path on a fresh copy of the store.",
    "",
    "| case | expect | baseline | probe | store_n | baseline B | probe B | Δ B | band B | Δ≈0 | " +
      "leftover | identity base/probe | injectBody baseline B | injectBody probe B | verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    rows,
    "",
    ...(notes ? ["## Notes", "", notes, ""] : []),
    ...(packets ? ["## Packet text", "", packets, ""] : []),
    "## A/A noise floor",
    "",
    "Packet bytes are arithmetic (ROADMAP §4.9 determinism). The A/A cell is two `EDEN_MEMORY=0` " +
      "injects of `what's 2+2?` on empty stores. Wall-clock is one sample pair and is not the verdict.",
    "",
    aa
      ? `- inject wall ms: ${aa.baseline.wall_ms.toFixed(3)} then ${aa.probe.wall_ms.toFixed(3)} (Δ ${wall} ms)`
      : "- A/A row missing",
    `- packet Δ: ${aa ? aa.delta_bytes : "n/a"} B`,
    "",
    "## Seed liveness (not a scored row)",
    "",
    "The seeded store is the same two facts. A related cue must inject sqlite, or the unrelated 0-byte " +
      "rows would be a dead store and are filed FAIL instead of Δ≈0. This cue is not a Gate 1 score and " +
      "not a product column.",
    "",
    `- cue: \`${run.seed_liveness.cue}\``,
    `- packet: ${run.seed_liveness.packet_bytes} B`,
    `- sqlite in packet: ${run.seed_liveness.sqlite ? "yes" : "no"}`,
    run.seed_liveness.preview ? `- text: ${cell(run.seed_liveness.preview)}` : "- text: (empty)",
    "",
    "## By construction",
    "",
    "Memorable **454/454** and Mem0 **92** fail by construction. They are not Eden product scores. " +
      "COMPETITORS V-zero. This is not a published BrainMemory column.",
    "",
    "| claim | why it fails by construction |",
    "|---|---|",
    "| Memorable 454/454 | Marketing 100% completion on a 3-bug fixture (`docs/MEMORY-COMPETITORS.md`). " +
      "Saturated fixture plus a skill-dump denominator. Not a negative control. Cannot be an Eden product " +
      "score. |",
    "| Mem0 92 | Vendor LoCoMo dirt (`docs/MEMORY-COMPETITORS.md`: Mem0 vendor LoCoMo 92). Gold is " +
      "dirty, the set is saturated, and this annex did not run LoCoMo. Cannot be an Eden product score. |",
    "| MemoryBench ELO | `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md` §11.2: often **No Memory ≈ " +
      "Embedder**. Humility: memory can be zero lift. |",
    "",
    "## Protocol",
    "",
    "- Inject path only: `openMemory` / `inject` / `injectBody`.",
    "- hook-inject (`memoryHookResponse` / `respondToHook`) is the Gate 1 host. It is named here and not re-scored.",
    "- k default (`EDEN_MEMORY_CAP` unset → 6). No k=40.",
    "- Store is empty or two remembered facts (`Use sqlite.` / `Auth is Clerk.`). No hay. No LoCoMo.",
    "- Off switch is `EDEN_MEMORY=0`. On is the unset product default.",
    "- `EDEN_KNOW=0` during seed and probe.",
    "- Seeded rows with `store_n` below the seed length are FAIL, not Δ≈0.",
    "- MEASURE rows that inject leftover sqlite/Clerk, or any Eden Memory packet outside the ±1% band, " +
      "are LOSS vs remain-silent. Omit is not implemented.",
    "- Ranker and extract were not retuned.",
    "",
    "## M32 remain-silent (cited, not re-run)",
    "",
    "`benchmarks/terminal-bench/RESULTS.md` on-arm empty/junk/on_cue/no_inject = 0/0/5/5 (dated " +
      "2026-09-21). This annex does not implement omit and does not re-run Harbor.",
    "",
    "## Product bugs",
    "",
    bugs,
    "",
    "## How to re-run",
    "",
    "```bash",
    "bun benchmarks/memory-holdout/run-negative.ts",
    "```",
    "",
    "Writes this file. Does not edit `negative-fixture.json`. Does not retune `src/index.ts`.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const run = runNegative({ out: NEGATIVE_PATH });
  process.stdout.write(formatNegative(run));
  const summary = run.rows.map((r) => `${r.id}\t${r.verdict}\tΔ${r.delta_bytes}`).join("\n");
  console.error(`\n${summary}`);
}
