/**
 * Semantic store (neocortex): facts consolidated at write time into
 * (subject, attribute, value-class, value, time) tuples with supersession links
 * (newest wins), aliases (speaker ↔ I/my) and question-frame vocab attached.
 */
import { contentToks, properNames, stem, WEEKDAYS } from "./text";
import type { Episode } from "./episodic";

export type ValueClass = "time" | "money" | "weekday" | "date" | "number" | "person" | "code" | "proper" | "generic";
export type Frame = "when" | "who" | "where" | "howmuch" | "which" | "what";

export type Fact = {
  ep: number;
  subject: string[];
  anchors: Set<string>;
  values: string[];
  vclass: ValueClass;
  frames: Set<Frame>;
  at: number;
  supersededBy?: number;
  supersedes?: number;
  changeSignal: boolean;
};

const CHANGE = /\b(moved|move|moving|now|switched|switch|transferred|revised|renegotiated|relocated|took over|change[ds]?|instead|new|updated|update|replaced|no longer|from now on|reassigned|rescheduled|swapped|became|becomes|will be|later|longer|anymore|instead of|is now|are now)\b/i;
const FRAME_OF: Record<ValueClass, Frame[]> = {
  time: ["when"],
  weekday: ["when"],
  date: ["when"],
  money: ["howmuch"],
  number: ["howmuch"],
  person: ["who"],
  code: ["which", "where"],
  proper: ["where", "which", "who"],
  generic: ["what", "which"],
};

function classify(tok: string, text: string, people: Set<string>): ValueClass | null {
  if (/^\d{1,2}:\d{2}$/.test(tok)) return "time";
  if (/^\$\d/.test(tok) || /^\d+(\.\d+)?$/.test(tok) && new RegExp(`\\$\\s?${tok}\\b`).test(text)) return "money";
  if (WEEKDAYS.includes(tok)) return "weekday";
  if (/^20\d{2}$/.test(tok)) return "date";
  if (/^\d+(\.\d+)?$/.test(tok)) return "number";
  if (/^(?=.*\d)(?=.*[a-z])[a-z0-9-]{2,12}$/.test(tok)) return "code";
  if (people.has(tok)) return "person";
  return null;
}

const RANK: ValueClass[] = ["time", "money", "weekday", "code", "date", "number", "person", "proper", "generic"];

export class SemanticStore {
  facts: Fact[] = [];
  byEp = new Map<number, Fact[]>();
  private byAnchor = new Map<string, Fact[]>();
  people = new Set<string>();

  compile(episodes: Episode[]) {
    this.facts = [];
    this.byEp.clear();
    this.byAnchor.clear();
    this.people.clear();
    for (const e of episodes) if (e.speaker) this.people.add(e.speaker.toLowerCase());
    for (const e of episodes) for (const m of e.text.match(/\b(?:Dr|Mr|Mrs|Ms)\.?\s+([A-Z][a-z]{2,16})/g) ?? []) this.people.add(m.split(/\s+/).pop()!.toLowerCase());
    // Names that appear as the subject of a fact-like sentence are people too.
    for (const e of episodes) for (const m of e.text.match(/(?:^|[.!?]\s+)([A-Z][a-z]{2,16})(?:'s)?\s+(?:is|has|was|plays|works|lives|stays|took|switched|moved)\b/g) ?? []) {
      const n = m.replace(/^[.!?\s]+/, "").split(/\s+|'/)[0]!.toLowerCase();
      this.people.add(n);
    }
    for (const e of episodes) {
      for (const f of this.compileEpisode(e)) this.add(f);
    }
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
        f.supersedes = best.ep;
      }
    }
    this.facts.push(f);
    const l = this.byEp.get(f.ep);
    if (l) l.push(f);
    else this.byEp.set(f.ep, [f]);
    for (const a of f.anchors) {
      const l2 = this.byAnchor.get(a);
      if (l2) l2.push(f);
      else this.byAnchor.set(a, [f]);
    }
  }

  private compileEpisode(e: Episode): Fact[] {
    const out: Fact[] = [];
    for (const raw of e.text.split(/(?<=[.!?;])\s+/)) {
      const s = raw.trim();
      if (s.length < 6 || s.endsWith("?")) continue;
      // Only declarative sentences with a copula / relation verb become facts.
      if (!/\b(is|are|was|were|has|have|had|'s|moved|switched|transferred|works|lives|stays|staying|plays|took|leaves|departs|departing|revised|renegotiated|relocated|costs?|due|owns?|owned|named|called|prefers?|uses?)\b/i.test(s)) continue;
      const text = s.replace(/\b(I|I'm|I've|my|me|mine)\b/g, (m) => (/^(my|mine)$/i.test(m) ? `${e.speaker}'s` : e.speaker));
      const low = text.toLowerCase();
      const names = properNames(text).filter((n) => !/^(gate|council|our|the|we|it|dr|there|this|that|they|he|she|inv)$/.test(n));
      const codes = (text.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{2,12}\b/g) ?? []).map((x) => x.toLowerCase());
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
      for (const n of names) cand.push({ v: n, c: this.people.has(n) ? "person" : "proper" });
      if (!cand.length) continue;
      let vclass: ValueClass = "generic";
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
      out.push({ ep: e.i, subject: names.slice(0, 2), anchors, values, vclass, frames, at: e.i, changeSignal: CHANGE.test(text) && !/^(?:[A-Z][a-z]+\s+)?(?:has|have|had) (?:been|had)?\s*(?:great|good|fun)\b/.test(text) });
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

  /**
   * Structured lookup: score episodes whose facts anchor on query entities and whose value
   * class matches the question frame. Returns episode -> score.
   */
  lookup(q: string): Map<number, number> {
    const out = new Map<number, number>();
    const frame = SemanticStore.frameOf(q);
    const qStems = new Set(contentToks(q).filter((s) => s.length >= 4 || /\d/.test(s)));
    const qNames = properNames(q).map((n) => `#${n}`);
    const qCodes = (q.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{2,12}\b/g) ?? []).map((x) => `#${x.toLowerCase()}`);
    const cues = new Set<string>([...qStems, ...qNames, ...qCodes]);
    if (!cues.size) return out;
    for (const f of this.facts) {
      let s = 0;
      let entity = 0;
      for (const a of f.anchors) {
        if (!cues.has(a)) continue;
        if (a.startsWith("#")) entity += 1;
        else s += 0.5;
      }
      if (!entity && !s) continue;
      s += entity * 2;
      if (frame && f.frames.has(frame)) s *= 1.6;
      else if (frame && frame !== "what" && frame !== "which") s *= 0.7;
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
