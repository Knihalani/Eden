/**
 * Semantic store (neocortex): facts consolidated at write time into
 * (subject, attribute, value-class, value, time) tuples with supersession links
 * (newest wins), aliases (speaker ↔ I/my) and question-frame vocab attached.
 */
import { codeToks, contentToks, properNames, stem } from "./text";
import type { Episode } from "./episodic";

export type ValueClass = "time" | "money" | "weekday" | "number" | "person" | "code" | "proper";
export type Frame = "when" | "who" | "where" | "howmuch" | "which";

export type Fact = {
  ep: number;
  anchors: Set<string>;
  values: string[];
  vclass: ValueClass;
  frames: Set<Frame>;
  at: number;
  supersededBy?: number;
  changeSignal: boolean;
};

const CHANGE = /\b(moved|move|moving|now|switched|switch|transferred|revised|renegotiated|relocated|took over|change[ds]?|instead|new|updated|update|replaced|no longer|from now on|reassigned|rescheduled|swapped|became|becomes|will be|later|longer|anymore|instead of|is now|are now)\b/i;
const FRAME_OF: Record<ValueClass, Frame[]> = {
  time: ["when"],
  weekday: ["when"],
  money: ["howmuch"],
  number: ["howmuch"],
  person: ["who"],
  code: ["which", "where"],
  proper: ["where", "which", "who"],
};

const RANK: ValueClass[] = ["time", "money", "weekday", "code", "number", "person", "proper"];

export class SemanticStore {
  facts: Fact[] = [];
  private byAnchor = new Map<string, Fact[]>();

  compile(episodes: Episode[]) {
    this.facts = [];
    this.byAnchor.clear();
    const people = new Set<string>();
    for (const e of episodes) {
      if (e.speaker) people.add(e.speaker.toLowerCase());
      for (const m of e.text.match(/\b(?:Dr|Mr|Mrs|Ms)\.?\s+([A-Z][a-z]{2,16})/g) ?? []) people.add(m.split(/\s+/).pop()!.toLowerCase());
      for (const m of e.text.match(/(?:^|[.!?]\s+)([A-Z][a-z]{2,16})(?:'s)?\s+(?:is|has|was|plays|works|lives|stays|took|switched|moved)\b/g) ?? []) {
        people.add(m.replace(/^[.!?\s]+/, "").split(/\s+|'/)[0]!.toLowerCase());
      }
    }
    for (const e of episodes) for (const f of this.compileEpisode(e, people)) this.add(f);
  }

  private add(f: Fact) {
    // Supersession: an earlier fact sharing an anchor with the same value class is superseded
    // when the newer sentence carries a change signal and a different value.
    if (f.changeSignal && f.values.length) {
      let best: Fact | undefined;
      for (const a of f.anchors) {
        for (const old of this.byAnchor.get(a) ?? []) {
          if (old.ep === f.ep || old.supersededBy !== undefined) continue;
          if (old.vclass !== f.vclass || !old.values.length) continue;
          if (old.values.some((v) => f.values.includes(v))) continue;
          let shared = 0;
          for (const x of old.anchors) if (f.anchors.has(x)) shared++;
          if (shared < 1) continue;
          if (!best || shared > sharedCount(best, f)) best = old;
        }
      }
      if (best) {
        best.supersededBy = f.ep;
      }
    }
    this.facts.push(f);
    for (const a of f.anchors) {
      const l2 = this.byAnchor.get(a);
      if (l2) l2.push(f);
      else this.byAnchor.set(a, [f]);
    }
  }

  private compileEpisode(e: Episode, people: Set<string>): Fact[] {
    const out: Fact[] = [];
    for (const raw of e.text.split(/(?<=[.!?;])\s+/)) {
      const s = raw.trim();
      if (s.length < 6 || s.endsWith("?")) continue;
      // Only declarative sentences with a copula / relation verb become facts.
      if (!/\b(is|are|was|were|has|have|had|'s|moved|switched|transferred|works|lives|stays|staying|plays|took|leaves|departs|departing|revised|renegotiated|relocated|costs?|due|owns?|owned|named|called|prefers?|uses?)\b/i.test(s)) continue;
      const text = s.replace(/\b(I|I'm|I've|my|me|mine)\b/g, (m) => (/^(my|mine)$/i.test(m) ? `${e.speaker}'s` : e.speaker));
      const low = text.toLowerCase();
      const names = properNames(text).filter((n) => !/^(gate|council|our|the|we|it|dr|there|this|that|they|he|she|inv)$/.test(n));
      const codes = codeToks(text);
      const times = text.match(/\b\d{1,2}:\d{2}\b/g) ?? [];
      const money = (text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/\s|,/g, ""));
      const weekdays = (low.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g) ?? []);
      const numbers = (low.match(/(?<![\d:$.])\b\d{1,6}\b(?![:\d])/g) ?? []).filter((n) => !money.some((m) => m.includes(n)));
      const stems = contentToks(text);
      // Anchors: the sentence's identifying nouns (rare-ish content stems ≥ 4 chars, names, codes).
      const anchors = new Set<string>();
      for (const st of stems) if (st.length >= 4 && !/^\d/.test(st) && !/^(gate|room|hotel|city|time|day|date|amount|term|practice|captain)$/.test(st)) anchors.add(st);
      for (const n of names) anchors.add(`#${n}`);
      for (const c of codes) anchors.add(`#${c}`);
      // Sentence-level noun cues that name the attribute (keep short common attribute nouns too).
      for (const st of stems) if (/^(gate|room|hotel|practice|captain|plumber|doctor|flight|copay|invoice|collection|follow|term|rent|coach|jersey|dose|budget|deadline)/.test(st)) anchors.add(st);
      // Values: entity-ish tokens by class, dominant class chosen by priority.
      const cand: { v: string; c: ValueClass }[] = [];
      for (const t of times) cand.push({ v: t, c: "time" });
      for (const m of money) cand.push({ v: m, c: "money" });
      for (const w of weekdays) cand.push({ v: w, c: "weekday" });
      for (const c of codes) cand.push({ v: c, c: "code" });
      for (const n of numbers) cand.push({ v: n, c: "number" });
      for (const n of names) cand.push({ v: n, c: people.has(n) ? "person" : "proper" });
      if (!cand.length) continue;
      let vclass: ValueClass = cand[0]!.c;
      for (const c of RANK) if (cand.some((x) => x.c === c)) { vclass = c; break; }
      const values = cand.filter((x) => x.c === vclass).map((x) => x.v);
      // Values are not anchors; the anchors must be the non-value identifiers.
      for (const v of values) { anchors.delete(`#${v}`); anchors.delete(stem(v)); }
      if (vclass === "person" || vclass === "proper") {
        // Subject entity stays an anchor when there are several names (P is seen by Dr. D): the
        // first name is the subject unless the sentence is "<Name> took over as ...".
        const subj = names[0];
        if (subj && values.length > 1 && !/\b(took over|replaced|became)\b/i.test(text)) {
          anchors.add(`#${subj}`);
          values.splice(values.indexOf(subj), 1);
        }
      }
      if (!anchors.size) continue;
      const frames = new Set<Frame>(FRAME_OF[vclass]);
      if (/\b(room|gate|city|country|town|park|field|hotel|street|address|where|in|at)\b/.test(low) && (vclass === "code" || vclass === "proper")) frames.add("where");
      out.push({ ep: e.i, anchors, values, vclass, frames, at: e.i, changeSignal: CHANGE.test(text) && !/^(?:[A-Z][a-z]+\s+)?(?:has|have|had) (?:been|had)?\s*(?:great|good|fun)\b/.test(text) });
    }
    return out;
  }

  /** Query frame from wh-words. */
  static frameOf(q: string): Frame | null {
    const low = q.toLowerCase();
    if (/\b(when|what time|what day|which day|what date|which date|what year|what month)\b/.test(low)) return "when";
    if (/\b(how much|how many|amount|cost|price|copay|rent|fee|total|balance|owe|pay)\b/.test(low)) return "howmuch";
    if (/\bwho(?:m|se)?\b/.test(low)) return "who";
    if (/\b(where|which (?:room|gate|city|country|town|hotel|venue|field|address|place|location))\b/.test(low)) return "where";
    if (/\bwhich\b/.test(low)) return "which";
    return null;
  }

  lookup(q: string): Map<number, number> {
    const out = new Map<number, number>();
    const cues = new Set([...contentToks(q).filter((s) => s.length >= 4 || /\d/.test(s)), ...properNames(q).map((n) => `#${n}`), ...codeToks(q).map((c) => `#${c}`)]);
    if (!cues.size) return out;
    for (const f of this.facts) {
      let s = 0;
      for (const a of f.anchors) if (cues.has(a)) s += a.startsWith("#") ? 2 : 0.5;
      if (!s) continue;
      if (f.supersededBy !== undefined) s *= 0.25;
      out.set(f.ep, Math.max(out.get(f.ep) || 0, s));
    }
    return out;
  }
}

function sharedCount(a: Fact, b: Fact): number {
  let n = 0;
  for (const x of a.anchors) if (b.anchors.has(x)) n++;
  return n;
}
