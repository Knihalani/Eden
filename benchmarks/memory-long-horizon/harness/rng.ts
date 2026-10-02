/**
 * Seeded randomness and the id formats Claude Code uses, so that a seed replays the same session byte for byte.
 */

/** One knot of an inverse CDF: the value at cumulative probability `p`. */
export type Knot = readonly [p: number, value: number];

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** sfc32, seeded through splitmix32. Small, fast and good enough for workload generation. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const split = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = split();
    this.b = split();
    this.c = split();
    this.d = split();
  }

  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t / 4294967296;
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error("pick from an empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** A draw from the distribution whose inverse CDF is linear between `knots` (first p = 0, last p = 1). */
  quantile(knots: readonly Knot[]): number {
    const u = this.next();
    for (let i = 1; i < knots.length; i++) {
      const [p0, v0] = knots[i - 1]!;
      const [p1, v1] = knots[i]!;
      if (u <= p1) return p1 === p0 ? v1 : v0 + ((u - p0) / (p1 - p0)) * (v1 - v0);
    }
    return knots[knots.length - 1]![1];
  }

  /** Poisson draw (Knuth); fine for the small means used here. */
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let k = 0;
    let product = this.next();
    while (product > limit) {
      k++;
      product *= this.next();
    }
    return k;
  }

  hex(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += "0123456789abcdef"[this.int(0, 15)];
    return out;
  }

  base62(length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += BASE62[this.int(0, 61)];
    return out;
  }
}

/** A random (version 4) UUID, as Claude Code uses for `prompt_id`, `session_id` and transcript `uuid`s. */
export function uuidV4(rng: Rng): string {
  const h = rng.hex(32).split("");
  h[12] = "4";
  h[16] = "89ab"[rng.int(0, 3)]!;
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** `toolu_01` and 22 base-62 characters, the shape of every captured `tool_use_id`. */
export function toolUseId(rng: Rng): string {
  return `toolu_01${rng.base62(22)}`;
}

/** `a` and 16 hex characters, the shape of every captured subagent `agent_id`. */
export function agentId(rng: Rng): string {
  return `a${rng.hex(16)}`;
}

/** The `~/.claude/projects/<slug>` directory name for a working directory: every non-alphanumeric becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
