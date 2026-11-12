/**
 * F10: the lab's rule index (`RuleIndex`, packages/engine/src/rule-index.ts), replaying e5 vectors computed offline
 * (`packages/sim/lab/f10/embed.py`, multilingual-e5-small int8 on CPU; `export-vecs.py` writes the file). A card
 * scores its best cosine to the request over `ruleTexts`. A request with no vector answers null (the caller's
 * unselected sheet); a card with no vector for any of its texts is not selected. Sim data only: the vectors are
 * content hashes' and shared by every user, which only a lab replay may do (a server's index keeps its own per user).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ruleTexts, topRules, type RuleCandidate, type RuleIndex } from "@eden/engine";

const key = (t: string) => createHash("sha1").update(t.replace(/\n/g, " ")).digest("hex");

export class ReplayRuleIndex implements RuleIndex {
  private readonly vecs = new Map<string, Float32Array>();
  /** Requests asked, and those with no vector (a coverage gap: each one read the unselected sheet). */
  asked = 0;
  misses = 0;

  constructor(file: string) {
    const raw = readFileSync(file);
    const json = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as {
      dim: number;
      vecs: Record<string, string>;
    };
    for (const [k, b64] of Object.entries(json.vecs)) {
      const bytes = Buffer.from(b64, "base64");
      // int8 scaled by 127 (each vector is unit length, so every component is within [-1, 1]).
      const v = new Float32Array(json.dim);
      for (let i = 0; i < json.dim; i++) v[i] = ((bytes[i]! << 24) >> 24) / 127;
      this.vecs.set(k, v);
    }
  }

  /** Each candidate's best cosine to the request, or null when the request has no vector. */
  scores(request: string, candidates: readonly RuleCandidate[]): Map<string, number> | null {
    const q = this.vecs.get(key(`query: ${request}`));
    if (!q) return null;
    const out = new Map<string, number>();
    for (const c of candidates) {
      const { passages, queries } = ruleTexts(c);
      let best = -Infinity;
      for (const t of [...passages.map((p) => `passage: ${p}`), ...queries.map((x) => `query: ${x}`)]) {
        const v = this.vecs.get(key(t));
        if (!v) continue;
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i]! * q[i]!;
        if (s > best) best = s;
      }
      if (Number.isFinite(best)) out.set(c.id, best);
    }
    return out;
  }

  async select(_scope: unknown, request: string, candidates: readonly RuleCandidate[], k: number) {
    this.asked++;
    const scores = this.scores(request, candidates);
    if (!scores) {
      this.misses++;
      return null;
    }
    return topRules(scores, k);
  }
}
