/**
 * A stand-in for the model, for when a live one is unavailable or too costly to run at scale: it reads the engine's
 * real judge prompt, maps each candidate back to its world item, and picks the ones relevant to the current task
 * with a configured accuracy. Its verdict is the JSON the engine parses, so delivery goes through the real code.
 *
 * With `tp` 1 and `fp` 0 it is a perfect judge: the result is the ceiling of the model path (the needed item was
 * among the candidates). Other settings model an imperfect cheap model. Neither is a measurement of a real model;
 * reports label them as modelled.
 */
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";
import { Rng } from "./rng";
import type { World, WorldItem } from "./world";

export interface OracleOptions {
  /** Probability a relevant candidate is picked. */
  tp: number;
  /** Probability an irrelevant candidate is picked. */
  fp: number;
  /** Median latency of a call, ms (log-normal, sigma 0.4), multiplied by timeScale. */
  latencyMs: number;
  timeScale: number;
  seed: number;
}

export interface OracleStats {
  judgeCalls: number;
  candidates: number;
  relevantCandidates: number;
  answerCalls: number;
  unmatched: number;
}

export class OracleJudge implements Model {
  readonly id = "oracle";
  readonly stats: OracleStats = { judgeCalls: 0, candidates: 0, relevantCandidates: 0, answerCalls: 0, unmatched: 0 };
  /** The facts that count as relevant right now (the runner sets this at each task's need turn). */
  relevant = new Set<string>();
  /** Ids of every candidate shown to the judge, in order. */
  readonly shown: string[] = [];
  private readonly byTitle = new Map<string, WorldItem[]>();
  private readonly rng: Rng;

  constructor(
    world: World,
    private readonly o: OracleOptions,
  ) {
    for (const it of world.items) {
      const k = `${it.sourceId}|${it.title.slice(0, 80)}`;
      const list = this.byTitle.get(k) ?? [];
      list.push(it);
      this.byTitle.set(k, list);
    }
    this.rng = new Rng(o.seed);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const system = request.messages[0]?.content ?? "";
    const userMsg = request.messages[1]?.content ?? "";
    // The labels of the turn that asked: the runner moves on to later turns while this call "thinks".
    const relevant = this.relevant;
    const delay = this.rng.lognormal(this.o.latencyMs, 0.4) * this.o.timeScale;
    if (delay > 0) await Bun.sleep(delay);
    if (request.signal?.aborted) throw request.signal.reason;
    let text = "";
    if (system.includes('{"pick"')) {
      this.stats.judgeCalls++;
      const picks: number[] = [];
      // Candidates are "[i] (source) title — text", and text keeps its newlines: split on the "[i] (source) " heads.
      const list = userMsg.split("\nCandidates:\n")[1] ?? "";
      // A head counts only if it is the next index: a line inside an item's text that looks like one is text.
      const heads: RegExpExecArray[] = [];
      for (const m of list.matchAll(/^\[(\d+)\] \(([^)\n]+)\) /gm)) if (Number(m[1]) === heads.length) heads.push(m);
      heads.forEach((m, k) => {
        const block = list.slice(m.index + m[0].length, heads[k + 1]?.index ?? list.length);
        this.stats.candidates++;
        const item = this.find(m[2]!, block);
        if (!item) this.stats.unmatched++;
        else this.shown.push(item.id);
        const rel = !!item && item.facts.some((f) => relevant.has(f));
        if (rel) this.stats.relevantCandidates++;
        if (this.rng.chance(rel ? this.o.tp : this.o.fp)) picks.push(Number(m[1]));
      });
      text = JSON.stringify({ pick: picks });
    } else {
      this.stats.answerCalls++;
      text = "Here is what the items say [0].";
    }
    const inputTokens = Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      text,
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4), cachedInputTokens: 0 },
      // Priced like the default model (z-ai/glm-5.3-flash at the list price docs/COST-MODEL.md uses).
      costUsd: (inputTokens * 0.15 + Math.ceil(text.length / 4) * 0.5) / 1e6,
      model: this.id,
      latencyMs: delay,
    };
  }

  /**
   * The world item a candidate block ("title — text") shows. A title may itself contain " — " ("Globex — call
   * notes"), so each split point is tried; titles are clipped to 80 characters with "…".
   */
  private find(sourceId: string, block: string): WorldItem | undefined {
    for (let at = block.indexOf(" — "); at >= 0; at = block.indexOf(" — ", at + 1)) {
      const title = block.slice(0, at).replace(/…$/, "");
      const list = this.byTitle.get(`${sourceId}|${title}`);
      if (!list) continue;
      if (list.length === 1) return list[0];
      // Several items share a title (a thread's replies, whose bodies start with the same headers): the one sharing
      // the longest prefix with the candidate's clipped text.
      const body = block
        .slice(at + 3)
        .replace(/…\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
      let best = list[0]!;
      let bestLen = -1;
      for (const it of list) {
        const text = it.text.replace(/\s+/g, " ");
        let n = 0;
        while (n < body.length && n < text.length && body.charCodeAt(n) === text.charCodeAt(n)) n++;
        if (n > bestLen) {
          best = it;
          bestLen = n;
        }
      }
      return best;
    }
    return undefined;
  }
}
