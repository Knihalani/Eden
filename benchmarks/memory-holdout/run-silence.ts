/**
 * M38.3 remain-silent holdout (inject path).
 *
 *   bun benchmarks/memory-holdout/run-silence.ts
 *
 * Pre-registered expects live in silence-fixture.json (ROADMAP §4.9).
 * This file measures openMemory.inject / injectBody. Run as above, it rewrites the
 * tracked SILENCE.md; runSilence() itself writes a report only to the `out` it is
 * given, so the tests render into a temp dir and leave the tree clean.
 * It does not edit the fixture, NEGATIVE.md, the ranker, wrap, or hook.
 *
 * Scored API: openMemory.inject. injectBody is the same AgentMemory path, checked
 * beside inject. hook-inject is named and not scored (dual-API forbidden).
 * k = product default (EDEN_MEMORY_CAP unset → 6). No hay. No BrainMemory.
 * Backbone N/A: no LLM reader.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, memoryRetrieveCap, openMemory } from "../../src/index.ts";
import { memoryConsent } from "../../src/memory-consent.ts";

export const HOLD_DIR = import.meta.dir;
export const FIXTURE_PATH = join(HOLD_DIR, "silence-fixture.json");
export const SILENCE_PATH = join(HOLD_DIR, "SILENCE.md");

export const REQUIRED_CASE_IDS = ["empty-math", "seeded-math", "aa-off", "seeded-times"] as const;

type Arm = "on" | "off";

export type SilenceCase = {
  id: string;
  title: string;
  store: "empty" | "sqlite-clerk";
  seed?: string[];
  leftover_needles?: string[];
  cue: string;
  arms: Arm[];
  expect: "OMIT";
  expect_note: string;
};

export type SilenceFixture = {
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
  backbone: string;
  delta_def: string;
  rotation: string;
  seed_liveness: { cue: string; needle: string; role: string };
  bans: string[];
  cases: SilenceCase[];
};

export type Probe = {
  arm: Arm;
  consent: string;
  k: number;
  identity: boolean;
  omitted: boolean;
  packet_bytes: number;
  packet_text: string;
  added_system_bytes: number;
  wall_ms: number;
  body_identity: boolean;
  body_omitted: boolean;
  body_packet_bytes: number;
  body_packet_text: string;
  body_agrees: boolean;
};

export type SilenceRow = {
  id: string;
  title: string;
  expect: SilenceCase["expect"];
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
  omitted_on: boolean | null;
  leftover: string[];
  body_leftover: string[];
  seed_live: boolean;
  verdict: "WIN" | "LOSS" | "FAIL";
  note: string;
};

export type SeedLiveness = {
  cue: string;
  packet_bytes: number;
  sqlite: boolean;
  preview: string;
};

export type SilenceRun = {
  date: string;
  registered: string;
  bun: string;
  api_under_test: string;
  k: string;
  materiality: number;
  backbone: string;
  rows: SilenceRow[];
  bugs: string[];
  seed_liveness: SeedLiveness;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadSilenceFixture(path = FIXTURE_PATH): SilenceFixture {
  return JSON.parse(readFileSync(path, "utf8")) as SilenceFixture;
}

export function silenceFixtureIssues(fix: SilenceFixture): string[] {
  const issues: string[] = [];
  if (fix.schema !== 1) issues.push(`schema ${fix.schema} !== 1`);
  if (fix.part !== "M38.3") issues.push(`part ${fix.part} !== M38.3`);
  if (!ISO_DATE.test(fix.dated_registered ?? "")) issues.push("dated_registered must be YYYY-MM-DD");
  if (fix.dated_registered !== "2026-09-24") issues.push(`dated_registered ${fix.dated_registered} !== 2026-09-24`);
  if (fix.api_under_test !== "openMemory.inject")
    issues.push(`api_under_test ${fix.api_under_test} !== openMemory.inject`);
  if (fix.k !== "default") issues.push(`k ${fix.k} !== default`);
  if (fix.k_default !== 6) issues.push(`k_default ${fix.k_default} !== 6`);
  if (fix.materiality !== 0.01) issues.push(`materiality ${fix.materiality} !== 0.01 (ROADMAP §4.9; do not retune)`);
  if (fix.know !== "EDEN_KNOW=0") issues.push("know must stay EDEN_KNOW=0");
  if (fix.backbone !== "N/A") issues.push("backbone must stay N/A (no LLM reader)");
  if (fix.off !== "EDEN_MEMORY=0") issues.push("off must stay EDEN_MEMORY=0");
  if (!fix.seed_liveness?.cue?.trim() || fix.seed_liveness.needle !== "sqlite")
    issues.push("seed_liveness must be a sqlite setup cue, not a scored row");
  const product = fix.product ?? [];
  for (const name of ["openMemory", "inject", "injectBody"]) {
    if (!product.includes(name)) issues.push(`product missing ${name}`);
  }
  if (!(fix.named_not_scored ?? []).includes("hook-inject")) issues.push("hook-inject must be named and not scored");
  const ids = new Set((fix.cases ?? []).map((c) => c.id));
  for (const id of REQUIRED_CASE_IDS) if (!ids.has(id)) issues.push(`missing case ${id}`);
  for (const c of fix.cases ?? []) {
    const raw = c as SilenceCase & Record<string, unknown>;
    if ("verdict" in raw || "delta_bytes" in raw || "packet_bytes" in raw)
      issues.push(`${c.id}: fixture must not hold measured fields`);
    if (c.expect !== "OMIT") issues.push(`${c.id}: expect ${c.expect} not OMIT`);
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
  }
  const times = fix.cases?.find((c) => c.id === "seeded-times");
  if (times && times.cue !== "What is 17 times 23?") issues.push("seeded-times cue must stay the rotation class");
  const math = fix.cases?.filter((c) => c.cue === "what's 2+2?") ?? [];
  if (math.length < 2) issues.push("math cue must remain as measurement (empty-math and A/A)");
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

function packetOmitted(identity: boolean, packet: string, addedBytes: number): boolean {
  return identity && byteLen(packet) === 0 && !packet.includes(MEMORY_MARK) && addedBytes === 0;
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
    const identity = out === messages;
    const added_system_bytes = byteLen(added);
    return {
      consent: memoryConsent(),
      k: memoryRetrieveCap(),
      identity,
      omitted: packetOmitted(identity, packet, added_system_bytes),
      packet_bytes: byteLen(packet),
      packet_text: packet,
      added_system_bytes,
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
    const added = systemTexts(list).join("\n");
    const body_identity = out === body;
    const added_system_bytes = byteLen(added);
    return {
      body_identity,
      body_omitted: packetOmitted(body_identity, packet, added_system_bytes),
      body_packet_bytes: byteLen(packet),
      body_packet_text: packet,
    };
  });
  const body_agrees =
    bodyProbe.body_identity === injectProbe.identity &&
    bodyProbe.body_omitted === injectProbe.omitted &&
    bodyProbe.body_packet_bytes === injectProbe.packet_bytes &&
    leftoversOf(bodyProbe.body_packet_text, needles).join("|") ===
      leftoversOf(injectProbe.packet_text, needles).join("|");
  return { arm, ...injectProbe, ...bodyProbe, body_agrees };
}

const junk: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-m38-"));
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

function onArmOmitted(row: { baseline: Probe; probe: Probe }): boolean | null {
  if (row.probe.arm === "on") return row.probe.omitted && row.probe.body_omitted;
  if (row.baseline.arm === "on") return row.baseline.omitted && row.baseline.body_omitted;
  return null;
}

function judge(row: Omit<SilenceRow, "verdict" | "note" | "omitted_on"> & { seed_expected: number; store: string }): {
  verdict: SilenceRow["verdict"];
  note: string;
  omitted_on: boolean | null;
} {
  const notes: string[] = [];
  const omitted_on = onArmOmitted(row);
  if (row.store !== "empty" && !row.seed_ok)
    notes.push(`seed store_n ${row.store_n} < ${row.seed_expected}; refusing a silence claim`);
  if (row.store !== "empty" && !row.seed_live)
    notes.push("related sqlite cue did not inject sqlite; silent rows are FAIL (dead store)");
  if (row.baseline.consent !== "off" && row.baseline.arm === "off")
    notes.push(`baseline consent ${row.baseline.consent} !== off`);
  if (row.probe.arm === "on" && row.probe.consent !== "on") notes.push(`probe consent ${row.probe.consent} !== on`);
  if (row.probe.arm === "off" && row.probe.consent !== "off") notes.push(`probe consent ${row.probe.consent} !== off`);
  if (row.baseline.k !== 6 || row.probe.k !== 6) notes.push(`k ${row.baseline.k}/${row.probe.k} !== 6`);
  if (!row.baseline.body_agrees)
    notes.push(
      `injectBody baseline packet ${row.baseline.body_packet_bytes} B identity ${row.baseline.body_identity} disagrees with inject ${row.baseline.packet_bytes} B`,
    );
  if (!row.probe.body_agrees)
    notes.push(
      `injectBody probe packet ${row.probe.body_packet_bytes} B identity ${row.probe.body_identity} disagrees with inject ${row.probe.packet_bytes} B`,
    );
  const setupBad = notes.some(
    (n) =>
      n.startsWith("seed") ||
      n.startsWith("related") ||
      n.startsWith("baseline consent") ||
      n.startsWith("probe consent") ||
      n.startsWith("k "),
  );
  const bothOmitted = row.baseline.omitted && row.probe.omitted && row.baseline.body_omitted && row.probe.body_omitted;
  const onOk = omitted_on === null ? bothOmitted : omitted_on === true;
  const silent =
    row.delta_approx_0 &&
    row.body_delta_bytes === 0 &&
    bothOmitted &&
    onOk &&
    row.leftover.length === 0 &&
    row.body_leftover.length === 0 &&
    row.baseline.body_agrees &&
    row.probe.body_agrees;
  if (setupBad) return { verdict: "FAIL", note: notes.join("; "), omitted_on };
  if (silent) return { verdict: "WIN", note: notes.join("; "), omitted_on };
  if (row.leftover.length) notes.push(`LOSS leftover ${row.leftover.join(", ")} in inject packet`);
  if (row.body_leftover.length) notes.push(`LOSS leftover ${row.body_leftover.join(", ")} in injectBody packet`);
  if (!row.delta_approx_0 || row.body_delta_bytes !== 0)
    notes.push(`LOSS packet Δ inject ${row.delta_bytes} B / injectBody ${row.body_delta_bytes} B`);
  if (omitted_on === false) notes.push("LOSS on-arm packet not omitted (Eden Memory: present)");
  if (omitted_on === null && !bothOmitted) notes.push("LOSS A/A packet not omitted");
  if (!row.probe.body_agrees || !row.baseline.body_agrees) notes.push("LOSS injectBody disagrees with inject");
  return { verdict: "LOSS", note: notes.join("; "), omitted_on };
}

export function runSilence(opts: { out?: string } = {}): SilenceRun {
  const fix = loadSilenceFixture();
  const issues = silenceFixtureIssues(fix);
  if (issues.length) throw new Error("silence fixture:\n" + issues.map((i) => `- ${i}`).join("\n"));
  const bugs: string[] = [];
  const rows: SilenceRow[] = [];
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
      const leftover = leftoversOf(probe.arm === "on" ? probe.packet_text : "", needles);
      const body_leftover = leftoversOf(probe.arm === "on" ? probe.body_packet_text : "", needles);
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
          `${c.id} baseline: injectBody packet ${baseline.body_packet_bytes} B / omitted ${baseline.body_omitted} vs inject ${baseline.packet_bytes} B / omitted ${baseline.omitted}`,
        );
      if (!probe.body_agrees)
        bugs.push(
          `${c.id} probe: injectBody packet ${probe.body_packet_bytes} B / omitted ${probe.body_omitted} vs inject ${probe.packet_bytes} B / omitted ${probe.omitted}`,
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
  const run: SilenceRun = {
    date: localDate(),
    registered: fix.dated_registered,
    bun: typeof Bun !== "undefined" ? Bun.version : "unknown",
    api_under_test: fix.api_under_test,
    k: `default (EDEN_MEMORY_CAP unset → ${fix.k_default})`,
    materiality: fix.materiality,
    backbone: "N/A (no LLM reader)",
    rows,
    bugs,
    seed_liveness: seedLiveness,
  };
  if (opts.out) writeFileSync(opts.out, formatSilence(run));
  return run;
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function omittedCell(v: boolean | null): string {
  return v === null ? "n/a" : yn(v);
}

function armBytes(row: SilenceRow, arm: Arm): string {
  const hits = [row.baseline, row.probe].filter((p) => p.arm === arm);
  if (!hits.length) return "—";
  return hits.map((p) => String(p.packet_bytes)).join(" / ");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

export function formatSilence(run: SilenceRun): string {
  const byId = (id: string) => run.rows.find((r) => r.id === id);
  const line = (r: SilenceRow | undefined) =>
    r
      ? `${r.verdict} · omitted on-arm ${omittedCell(r.omitted_on)} · ${armBytes(r, "off")} B off ` +
        `→ ${armBytes(r, "on")} B on · Δ ${r.delta_bytes} B · ` +
        `leftover ${r.leftover.length ? r.leftover.join(", ") : "none"}`
      : "missing";
  const rows = run.rows
    .map(
      (r) =>
        `| ${r.id} | ${omittedCell(r.omitted_on)} | ${armBytes(r, "off")} | ${armBytes(r, "on")} ` +
        `| ${r.delta_bytes} | ${r.leftover.length ? cell(r.leftover.join(", ")) : "—"} | ${r.verdict} |`,
    )
    .join("\n");
  const bodyRows = run.rows
    .map(
      (r) =>
        `| ${r.id} | ${yn(r.baseline.body_agrees && r.probe.body_agrees)} | ${r.baseline.body_packet_bytes} ` +
        `| ${r.probe.body_packet_bytes} | ${r.body_delta_bytes} ` +
        `| ${r.body_leftover.length ? cell(r.body_leftover.join(", ")) : "—"} ` +
        `| ${yn(r.probe.arm === "on" ? r.probe.body_omitted : r.baseline.body_omitted && r.probe.body_omitted)} ` +
        `|`,
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
    : "- None on this run. injectBody packet bytes, omit, and identity matched inject on every arm.";
  const wins = run.rows.filter((r) => r.verdict === "WIN").map((r) => r.id);
  const losses = run.rows.filter((r) => r.verdict === "LOSS").map((r) => r.id);
  const fails = run.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id);
  return [
    "# M38.3 Remain-silent SILENCE",
    "",
    `**Date:** ${run.date}`,
    `**Pre-registered:** ${run.registered} (\`silence-fixture.json\`, ROADMAP §4.9). Expects were not edited after this run.`,
    `**Bun:** ${run.bun}`,
    "**Part:** M38.3",
    `**API under test:** inject path (\`openMemory\` / \`inject\`). \`injectBody\` is the same \`openMemory\` path, checked beside inject and not a second product.`,
    "**hook-inject:** named, not scored. Dual-API forbidden.",
    `**k:** ${run.k}`,
    `**Backbone:** ${run.backbone}`,
    `**Materiality:** ±${run.materiality * 100}% (band = materiality × max(baseline bytes, 1)). Baseline 0 ⇒ band 0.01 byte ⇒ only Δ = 0 is Δ≈0. Registered once.`,
    "**Off:** `EDEN_MEMORY=0` (inject identity). **On:** `EDEN_MEMORY` unset (product default).",
    "**Know:** `EDEN_KNOW=0` so the Know catalog is not this memory packet.",
    "",
    "No BrainMemory column. Inject path only. k default. No hay. No k=40. LoCoMo 92 is not an Eden claim. Ranker not tuned. Dual-API forbidden. Math cues are measurement reuse of M35.1, not a new training target. Rotation cell is `What is 17 times 23?`.",
    "",
    "Remain-silent is compatible with fail-open; Start briefing is M38.2/M7.3 not this annex.",
    "",
    "## Key numbers",
    "",
    `- **empty-math:** ${line(byId("empty-math"))}`,
    `- **seeded-math:** ${line(byId("seeded-math"))}`,
    `- **aa-off (noise floor):** ${line(byId("aa-off"))}`,
    `- **seeded-times (rotation):** ${line(byId("seeded-times"))}`,
    `- **WIN:** ${wins.length ? wins.join(", ") : "none"}`,
    `- **LOSS:** ${losses.length ? losses.join(", ") : "none"}`,
    `- **FAIL:** ${fails.length ? fails.join(", ") : "none"}`,
    "",
    "## Silence table",
    "",
    "Scored bytes are the UTF-8 length of system content containing `Eden Memory:`. Δ = probe − baseline. Omitted on-arm is yes only when the on arm has no `Eden Memory:` packet (inject identity, 0 bytes). A/A has no on-arm, so that cell is n/a; both off packets must still be omitted for WIN. Packet bytes are arithmetic.",
    "",
    "| case | omitted on-arm | packet B off | packet B on | Δ B | leftover | verdict |",
    "|---|---|---|---|---|---|---|",
    rows,
    "",
    "## injectBody (same path)",
    "",
    "`injectBody` must agree with `inject` on identity, omit, packet bytes, and leftover. It is not a second product column.",
    "",
    "| case | agrees | injectBody baseline B | injectBody probe B | injectBody Δ B | leftover | omitted |",
    "|---|---|---|---|---|---|---|",
    bodyRows,
    "",
    ...(notes ? ["## Notes", "", notes, ""] : []),
    ...(packets ? ["## Packet text", "", packets, ""] : []),
    "## A/A noise floor",
    "",
    "Packet bytes are arithmetic (ROADMAP §4.9 determinism). The A/A cell is two `EDEN_MEMORY=0` injects of `what's 2+2?` on empty stores. Wall-clock is one sample pair and is not the verdict.",
    "",
    aa
      ? `- inject wall ms: ${aa.baseline.wall_ms.toFixed(3)} then ${aa.probe.wall_ms.toFixed(3)} (Δ ${wall} ms)`
      : "- A/A row missing",
    `- packet Δ: ${aa ? aa.delta_bytes : "n/a"} B`,
    `- both omitted: ${aa ? yn(aa.baseline.omitted && aa.probe.omitted) : "n/a"}`,
    "",
    "## Seed liveness (not a scored row)",
    "",
    "The seeded store is the same two facts (`Use sqlite.` / `Auth is Clerk.`). A related cue must inject sqlite, or the silent rows are FAIL (dead store). This cue is not a scored Δ row and not a product column.",
    "",
    `- cue: \`${run.seed_liveness.cue}\``,
    `- packet: ${run.seed_liveness.packet_bytes} B`,
    `- sqlite in packet: ${run.seed_liveness.sqlite ? "yes" : "no"}`,
    run.seed_liveness.preview ? `- text: ${cell(run.seed_liveness.preview)}` : "- text: (empty)",
    "",
    "## Protocol",
    "",
    "- Inject path only: `openMemory` / `inject` / `injectBody`.",
    "- hook-inject (`memoryHookResponse` / `respondToHook`) is named here and not scored.",
    "- k default (`EDEN_MEMORY_CAP` unset → 6). No k=40.",
    "- Backbone N/A. No LLM reader.",
    "- Store is empty or two remembered facts (`Use sqlite.` / `Auth is Clerk.`). No hay. No LoCoMo.",
    "- Off switch is `EDEN_MEMORY=0`. On is the unset product default.",
    "- `EDEN_KNOW=0` during seed and probe.",
    "- Silence cells are pre-registered OMIT: Δ≈0 and packet omitted.",
    "- Seeded rows with `store_n` below the seed length, or a dead store on the related sqlite cue, are FAIL, not WIN.",
    "- Leftover sqlite or Clerk on an on-arm, or any `Eden Memory:` packet outside the ±1% band, is a named LOSS.",
    "- Ranker was not retuned. `NEGATIVE.md` was not edited. `negative-fixture.json` was not retuned.",
    "",
    "## Product bugs",
    "",
    bugs,
    "",
    "## How to re-run",
    "",
    "```bash",
    "bun benchmarks/memory-holdout/run-silence.ts",
    "```",
    "",
    "Writes this file. Does not edit `silence-fixture.json`. Does not retune `src/index.ts`.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const run = runSilence({ out: SILENCE_PATH });
  process.stdout.write(formatSilence(run));
  const summary = run.rows
    .map(
      (r) =>
        `${r.id}\t${r.verdict}\tΔ${r.delta_bytes}\tomitted=${r.omitted_on === null ? "n/a" : r.omitted_on ? "yes" : "no"}`,
    )
    .join("\n");
  console.error(`\n${summary}`);
}
