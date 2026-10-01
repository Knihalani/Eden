/**
 * Oracle for the hard memory bench. Pure functions: it reads packet text and the world, never the product.
 * Definitions follow docs/memory-ship/A5-EVALUATION.md §2: stale against the world oracle; false against the
 * case's needs ∪ allowed, where allowed = the other true statements about an asked slot (a negation); redundant
 * against the simulated window (the cue); silence on negatives.
 */
import type { Category, HardCase, Split, Statement, World } from "./hard-world";

export type BulletClass = "need" | "allowed" | "redundant" | "stale" | "false";
export type Check = "need" | "precision" | "stale" | "redundant" | "silence";
export const CHECKS: Check[] = ["need", "precision", "stale", "redundant", "silence"];

/** What a bullet says: a known statement, a value for a slot (a rewritten copula), background, or nothing known. */
export type Claim = {
  via: "statement" | "copula" | "filler" | "unknown";
  stmt?: Statement;
  slot?: string;
  value?: string;
};

export type ScoredBullet = { text: string; cls: BulletClass; via: Claim["via"]; slot?: string };

export type CaseResult = {
  id: string;
  split: Split;
  category: Category;
  packet: boolean;
  bullets: ScoredBullet[];
  missed: string[];
  /** Bullets about the asked slot type, but for another unit or repo (the wrong subject won). */
  wrongScope: number;
  checks: Check[];
  fails: Check[];
};

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "what",
  "whats",
  "which",
  "where",
  "when",
  "who",
  "how",
  "does",
  "did",
  "its",
  "our",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "this",
  "that",
  "into",
  "onto",
  "from",
  "use",
  "uses",
  "used",
  "one",
  "there",
  "here",
  "then",
  "than",
  "you",
  "your",
  "can",
  "should",
  "would",
  "will",
  "not",
  "now",
  "every",
]);

/** Lower-cased word tokens of three or more characters, minus function words. */
export function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Crude suffix stripping, so "tests" and "test" or "deploys" and "deploy" count as the same word. */
export function stem(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Bullet or statement text without the list dash, provenance labels, case or end punctuation. */
function norm(text: string): string {
  return text
    .replace(/^\s*-\s+/, "")
    .replace(/^(?:\[[^\]]*\]\s*)+/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?]+$/, "")
    .trim();
}

function subjectKey(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const COPULA = /^(?:the\s+)?(.{1,120}?)\s+(?:is now|is|uses)\s+(.+)$/;

/** `billing.db` → [`billing`, `db`]; `repo:acme-shop.pkg` → [`repo:acme-shop`, `pkg`]. */
function splitSlot(slot: string): [string, string] {
  const i = slot.indexOf(".");
  return i < 0 ? [slot, ""] : [slot.slice(0, i), slot.slice(i + 1)];
}

export function packetText(messages: unknown[], mark: string): string {
  return (Array.isArray(messages) ? messages : [])
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? [c] : [];
    })
    .filter((c) => c.includes(mark))
    .join("\n");
}

export function bulletsOf(packet: string): string[] {
  return packet.split("\n").filter((l) => /^\s*-\s+/.test(l));
}

export class Oracle {
  private readonly byText = new Map<string, Statement>();
  private readonly filler: Set<string>;
  private readonly subjects = new Map<string, string>();
  private readonly history = new Map<string, Set<string>>();

  constructor(private readonly world: World) {
    for (const s of world.statements) {
      this.byText.set(norm(s.text), s);
      const m = norm(s.text).match(COPULA);
      if (m && !this.subjects.has(subjectKey(m[1]!))) this.subjects.set(subjectKey(m[1]!), s.slot);
      if (s.value !== undefined) {
        const seen = this.history.get(s.slot) ?? new Set<string>();
        seen.add(s.value.toLowerCase());
        this.history.set(s.slot, seen);
      }
    }
    this.filler = new Set(world.filler.map(norm));
  }

  /** A statement is stale when the value it asserts (or denies) disagrees with the world's current value. */
  isStale(s: Statement): boolean {
    const now = this.world.current.get(s.slot)?.toLowerCase();
    if (s.value !== undefined) return s.value.toLowerCase() !== now;
    return s.not !== undefined && s.not.toLowerCase() === now;
  }

  claim(bullet: string): Claim {
    const n = norm(bullet);
    const exact = this.byText.get(n);
    if (exact) return { via: "statement", stmt: exact, slot: exact.slot };
    if (this.filler.has(n)) return { via: "filler" };
    let best: Statement | undefined;
    for (const s of this.world.statements) {
      const t = norm(s.text);
      const inside = n.includes(t) || (n.length >= 12 && t.includes(n));
      if (inside && (!best || t.length > norm(best.text).length)) best = s;
    }
    if (best) return { via: "statement", stmt: best, slot: best.slot };
    const m = n.match(COPULA);
    const slot = m ? this.subjects.get(subjectKey(m[1]!)) : undefined;
    if (m && slot) return { via: "copula", slot, value: m[2]!.trim() };
    return { via: "unknown" };
  }

  classify(c: HardCase, claim: Claim): BulletClass {
    const slot = claim.slot;
    if (!slot) return "false";
    const now = this.world.current.get(slot)?.toLowerCase();
    const stale = claim.stmt
      ? this.isStale(claim.stmt)
      : claim.value?.toLowerCase() !== now && !!this.history.get(slot)?.has(claim.value?.toLowerCase() ?? "");
    if (stale) return "stale";
    if (!claim.stmt && claim.value?.toLowerCase() !== now) return "false";
    if (c.states.includes(slot)) return "redundant";
    // A true statement about an asked slot that asserts no value (a negation) is allowed but answers nothing.
    if (c.needs.includes(slot)) return claim.stmt && claim.stmt.value === undefined ? "allowed" : "need";
    return "false";
  }

  score(c: HardCase, bullets: string[], packet: boolean): CaseResult {
    const scored = bullets.map((text): ScoredBullet => {
      const claim = this.claim(text);
      return { text, cls: this.classify(c, claim), via: claim.via, slot: claim.slot };
    });
    const missed = c.needs.filter(
      (slot) => !c.states.includes(slot) && !scored.some((b) => b.cls === "need" && b.slot === slot),
    );
    const checks: Check[] = c.needs.length
      ? ["need", "precision", "stale", ...(c.states.length ? (["redundant"] as const) : [])]
      : ["silence"];
    const failed: Record<Check, boolean> = {
      need: missed.length > 0,
      precision: scored.some((b) => b.cls === "false"),
      stale: scored.some((b) => b.cls === "stale"),
      redundant: scored.some((b) => b.cls === "redundant"),
      silence: packet || scored.length > 0,
    };
    const fails = checks.filter((k) => failed[k]);
    const asked = c.needs.map(splitSlot);
    const wrongScope = scored.filter((b) => {
      if (!b.slot || (b.cls !== "false" && b.cls !== "stale")) return false;
      const [owner, type] = splitSlot(b.slot);
      return asked.some(([o, t]) => t === type && o !== owner);
    }).length;
    const { id, split, category } = c;
    return { id, split, category, packet, bullets: scored, missed, wrongScope, checks, fails };
  }
}

export type Tally = { fail: number; total: number };

export type Summary = {
  cases: number;
  passed: number;
  checks: number;
  metric: number;
  byCheck: Record<Check, Tally>;
  byCategory: Map<Category, { cases: number; checks: number; fails: number; byCheck: Record<Check, Tally> }>;
  positives: number;
  needMiss: number;
  bullets: number;
  staleBullets: number;
  /** A5 false_rate numerator: bullets ∉ needs ∪ allowed, which includes stale bullets. */
  falseBullets: number;
  redundantBullets: number;
  wrongScopeBullets: number;
  unknownBullets: number;
  ack: Tally;
  nonhuman: Tally;
};

function emptyChecks(): Record<Check, Tally> {
  return Object.fromEntries(CHECKS.map((k) => [k, { fail: 0, total: 0 }])) as Record<Check, Tally>;
}

export function summarize(results: CaseResult[]): Summary {
  const s: Summary = {
    cases: results.length,
    passed: 0,
    checks: 0,
    metric: 0,
    byCheck: emptyChecks(),
    byCategory: new Map(),
    positives: 0,
    needMiss: 0,
    bullets: 0,
    staleBullets: 0,
    falseBullets: 0,
    redundantBullets: 0,
    wrongScopeBullets: 0,
    unknownBullets: 0,
    ack: { fail: 0, total: 0 },
    nonhuman: { fail: 0, total: 0 },
  };
  for (const r of results) {
    const cat = s.byCategory.get(r.category) ?? { cases: 0, checks: 0, fails: 0, byCheck: emptyChecks() };
    s.byCategory.set(r.category, cat);
    cat.cases++;
    for (const k of r.checks) {
      const failed = r.fails.includes(k);
      s.checks++;
      cat.checks++;
      s.byCheck[k].total++;
      cat.byCheck[k].total++;
      if (!failed) continue;
      s.metric++;
      cat.fails++;
      s.byCheck[k].fail++;
      cat.byCheck[k].fail++;
    }
    if (!r.fails.length) s.passed++;
    if (r.checks.includes("need")) s.positives++;
    if (r.missed.length) s.needMiss++;
    s.bullets += r.bullets.length;
    s.wrongScopeBullets += r.wrongScope;
    for (const b of r.bullets) {
      if (b.cls === "stale") s.staleBullets++;
      if (b.cls === "stale" || b.cls === "false") s.falseBullets++;
      if (b.cls === "redundant") s.redundantBullets++;
      if (b.via === "unknown") s.unknownBullets++;
    }
    const gate = r.category === "ack" ? s.ack : r.category === "nonhuman" ? s.nonhuman : undefined;
    if (gate) {
      gate.total++;
      if (r.fails.length) gate.fail++;
    }
  }
  return s;
}
