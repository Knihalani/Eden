/**
 * M48.3 hook-inject silence probe (holdout junk + remain-silent math).
 *
 *   bun benchmarks/memory-holdout/run-holdout-silence.ts
 *
 * Scores respondToHook → memoryHookResponse UserPromptSubmit only.
 * Does not retune the ranker, silence-fixture.json, or run-holdout.ts.
 * Does not write RESULTS.md.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHook } from "../../packages/cli/src/hook.ts";
import { MEMORY_MARK, memoryRetrieveCap, openMemory } from "../../src/index.ts";
import { additionalContextOf, hitsIn, withEnv } from "./run-tools.ts";
import { loadHoldoutFixture } from "./run-holdout.ts";

const MATH_CUES = ["what's 2+2?", "What is 17 times 23?"] as const;
const SEED = ["Use sqlite.", "Auth is Clerk."] as const;
const LIVE_CUE = "What sqlite database do we use?";
const LEFTOVER = ["sqlite", "Clerk"];

type Rec = Record<string, unknown>;

function assertProtocol(): void {
  if (process.env.EDEN_MEMORY_CAP) throw new Error("EDEN_MEMORY_CAP must stay unset");
  const k = memoryRetrieveCap();
  if (k !== 6) throw new Error(`memoryRetrieveCap ${k} !== 6`);
}

function armEnv(arm: "on" | "off", home: string): Record<string, string | undefined> {
  return {
    EDEN_MEMORY: arm === "off" ? "0" : undefined,
    EDEN_HOME: home,
    EDEN_MEMORY_DIR: join(home, "memory"),
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

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "eden-m483-"));
}

/** Hook echoes one packet on additional_context and hookSpecificOutput.additionalContext. Score it once. */
function packetOf(out: unknown): { text: string; bytes: number; omitted: boolean; mark: boolean; raw: string } {
  const raw = additionalContextOf(out as Rec);
  const blocks = raw.split(/(?=Eden Memory:)/).map((s) => s.trim()).filter((s) => s.includes(MEMORY_MARK));
  const uniq: string[] = [];
  for (const b of blocks) if (!uniq.includes(b)) uniq.push(b);
  const text = uniq.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const mark = text.includes(MEMORY_MARK);
  const omitted = !mark && bytes === 0 && !raw.trim();
  return { text, bytes, omitted, mark, raw };
}

async function submit(home: string, arm: "on" | "off", body: Rec): Promise<ReturnType<typeof packetOf>> {
  return withEnv(armEnv(arm, home), async () => {
    assertProtocol();
    const out = await respondToHook(body);
    return packetOf(out);
  });
}

async function junkCase(): Promise<Record<string, unknown>> {
  const fix = loadHoldoutFixture();
  const c = fix.cases.find((x) => x.id === "junk");
  if (!c) throw new Error("holdout junk case missing");
  const home = freshHome();
  try {
    const onPackets: string[] = [];
    for (const ev of c.observe) {
      const p = await submit(home, "on", ev as unknown as Rec);
      onPackets.push(p.text);
    }
    const cue = await submit(home, "on", c.cue as unknown as Rec);
    const gold = hitsIn(cue.text, c.gold_needles);
    const junk = hitsIn(cue.text, c.junk_needles ?? []);
    const offHome = freshHome();
    let off: ReturnType<typeof packetOf>;
    try {
      for (const ev of c.observe) await submit(offHome, "off", ev as unknown as Rec);
      off = await submit(offHome, "off", c.cue as unknown as Rec);
    } finally {
      rmSync(offHome, { recursive: true, force: true });
    }
    const pass = gold.miss.length === 0 && junk.hit.length === 0 && cue.mark && off.omitted;
    return {
      id: "junk",
      cue: c.cue.prompt,
      gold_hit: gold.hit,
      gold_miss: gold.miss,
      junk_hit: junk.hit,
      packet_bytes_on: cue.bytes,
      packet_bytes_off: off.bytes,
      delta_bytes: cue.bytes - off.bytes,
      omitted_on: cue.omitted,
      omitted_off: off.omitted,
      mark_on: cue.mark,
      preview: cue.text.replace(/\s+/g, " ").trim().slice(0, 400),
      pass,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function mathCase(): Promise<Record<string, unknown>> {
  const session = "m483-silent-math";
  const cwd = "/tmp/eden-m483-silent-math";
  const home = freshHome();
  const offHome = freshHome();
  try {
    for (const prompt of SEED) {
      await submit(home, "on", { hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt });
    }
    const live = await submit(home, "on", { hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt: LIVE_CUE });
    const storeN = withEnv(armEnv("on", home), async () => {
      assertProtocol();
      const mem = openMemory({ dir: join(home, "memory"), session });
      try {
        return mem.memories().map((m) => m.text);
      } finally {
        mem.close();
      }
    });
    const cues = [];
    for (const prompt of MATH_CUES) {
      const on = await submit(home, "on", { hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt });
      const off = await submit(offHome, "off", { hook_event_name: "UserPromptSubmit", session_id: session, cwd, prompt });
      const leftover = hitsIn(on.text, LEFTOVER).hit;
      cues.push({
        cue: prompt,
        packet_bytes_on: on.bytes,
        packet_bytes_off: off.bytes,
        delta_bytes: on.bytes - off.bytes,
        omitted_on: on.omitted,
        omitted_off: off.omitted,
        mark_on: on.mark,
        leftover,
        preview: on.text.replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }
    const texts = await storeN;
    const liveHit = hitsIn(live.text, ["sqlite"]).hit;
    const allOmit = cues.every((c) => c.omitted_on && c.omitted_off && c.delta_bytes === 0 && c.leftover.length === 0);
    return {
      id: "silent-math",
      store: texts,
      live_cue: LIVE_CUE,
      live_bytes: live.bytes,
      live_sqlite: liveHit.includes("sqlite"),
      live_preview: live.text.replace(/\s+/g, " ").trim().slice(0, 240),
      cues,
      pass: allOmit && liveHit.includes("sqlite") && texts.some((t) => /sqlite/i.test(t)) && texts.some((t) => /Clerk/.test(t)),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(offHome, { recursive: true, force: true });
  }
}

const junk = await junkCase();
const math = await mathCase();
process.stdout.write(JSON.stringify({ k: memoryRetrieveCap(), junk, math }, null, 2) + "\n");
