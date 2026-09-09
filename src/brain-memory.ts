/**
 * BrainMemory — Complementary Learning Systems (CLS) rebuild.
 *
 * Two stores + a controller (src/cls/*):
 *   EPISODIC (hippocampus)  — sparse pattern-separated turn keys, attractor-style
 *                              pattern completion (src/cls/episodic.ts)
 *   SEMANTIC (neocortex)    — entity/attribute/value/time tuples with supersession,
 *                              aliases and question-frame vocab (src/cls/semantic.ts)
 *   CONTROLLER               — classifies the query, runs + fuses both stores plus the
 *                              existing Eden cortex lane, enforces the context budget
 *                              (src/cls/controller.ts)
 *
 * BrainMemory itself is now a thin adapter that keeps the public API the benches use
 * (`ingestTurns` / `ingestTexts` / `retrieve` / `injectBlock` / `stored` / `close`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "./index";
import { CLSController } from "./cls/controller";

export type BrainTurn = {
  text: string;
  speaker?: string;
  date?: string;
  session?: number;
  at?: number;
};

export class BrainMemory {
  private semantic: AgentMemory;
  private cls: CLSController;
  private dir: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir || mkdtempSync(join(tmpdir(), "eden-brain-"));
    this.semantic = openMemory({ dir: this.dir });
    this.cls = new CLSController(this.semantic);
  }

  ingestTurns(turns: BrainTurn[]) {
    const normalized = turns.map((t, i) => ({
      text: String(t.text || ""),
      speaker: t.speaker || "speaker",
      date: t.date || "",
      session: t.session ?? 0,
      at: t.at ?? i,
    }));
    this.cls.ingest(normalized);
  }

  /** Ingest plain chat strings (`Speaker: text`) without dates. */
  ingestTexts(texts: string[]) {
    this.ingestTurns(
      texts.map((raw, i) => {
        const m = raw.match(/^([A-Za-z][A-Za-z0-9 /._-]{0,32}):\s*([\s\S]+)$/);
        return m ? { speaker: m[1], text: m[2]!.trim(), at: i } : { speaker: "speaker", text: raw.trim(), at: i };
      }),
    );
  }

  retrieve(q: string, k = 6): string[] {
    return this.cls.retrieve(q, k);
  }

  /** Inject block for agent prompts. */
  injectBlock(q: string, k = 6): string {
    const notes = this.retrieve(q, k);
    if (!notes.length) return "";
    return `Eden Brain Memory:\n${notes.map((n) => `- ${n}`).join("\n")}`;
  }

  stored(): string[] {
    return this.cls.epi.episodes.map((e) => e.render);
  }

  close() {
    this.semantic.close();
  }
}

export function openBrainMemory(opts: { dir?: string } = {}): BrainMemory {
  return new BrainMemory(opts);
}
