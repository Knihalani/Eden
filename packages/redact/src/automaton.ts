/**
 * The allowlist engine (D1705): gitleaks' allowlist regexes, run as a lazily built DFA over a Thompson NFA. An
 * allowlist only asks whether a regex occurs in a secret, a match or a line, so the engine answers `test` alone: one
 * pass over the text's code points, one table lookup per character once a state is built, at most one closure over
 * the NFA's nodes when it is not. Time is linear in the text for every pattern, whatever the input (D24).
 *
 * It reads RE2 syntax as gitleaks writes it, with the meanings the gate gave these regexes on re2js before D1705
 * (`re2Source` in re2-oracle.ts): `\s` is JavaScript's whitespace set and `\S` its complement, `.` is anything but
 * `\n`, `\r`, U+2028 and U+2029 (also under `(?s)`, as `re2Source` rewrote every `.`), `(?i)` folds case by Unicode
 * simple folding (`s` also matches U+017F, `k` U+212A), `^`/`$` are the text's ends, `\b`/`\B` ASCII word
 * boundaries, and the text is read by code point (a lone surrogate is one). Syntax outside that subset throws when
 * the pattern compiles, so a gitleaks update that adds one fails every test that builds the gate rather than
 * matching something else. re2js stays a devDependency as the oracle: `differential.ts` checks this engine against
 * it on every allowlist regex.
 */

/** A set of code points: sorted, disjoint, inclusive ranges `[lo0, hi0, lo1, hi1, …]`. */
export type Ranges = number[];

const MAX_CP = 0x10ffff;

function normalize(ranges: number[]): Ranges {
  const pairs: [number, number][] = [];
  for (let i = 0; i < ranges.length; i += 2) pairs.push([ranges[i]!, ranges[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: Ranges = [];
  for (const [lo, hi] of pairs) {
    const last = out.length - 1;
    if (last > 0 && lo <= out[last]! + 1) out[last] = Math.max(out[last]!, hi);
    else out.push(lo, hi);
  }
  return out;
}

function negate(ranges: Ranges): Ranges {
  const out: Ranges = [];
  let next = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i]! > next) out.push(next, ranges[i]! - 1);
    next = ranges[i + 1]! + 1;
  }
  if (next <= MAX_CP) out.push(next, MAX_CP);
  return out;
}

function contains(ranges: Ranges, cp: number): boolean {
  for (let i = 0; i < ranges.length; i += 2) {
    if (cp < ranges[i]!) return false;
    if (cp <= ranges[i + 1]!) return true;
  }
  return false;
}

const LONG_S = 0x17f;
const KELVIN = 0x212a;

/**
 * Adds the case-fold partners of every member, as RE2 does under `(?i)`: an ASCII letter's other case, and U+017F
 * with `s`/`S`, U+212A with `k`/`K` (the only characters outside ASCII whose simple folding reaches an ASCII letter).
 * A cased character outside ASCII would need Unicode's tables: it throws, as no vendored pattern holds one.
 */
function fold(ranges: Ranges): Ranges {
  const out = [...ranges];
  const add = (cp: number) => out.push(cp, cp);
  for (let i = 0; i < ranges.length; i += 2) {
    const lo = ranges[i]!;
    const hi = ranges[i + 1]!;
    for (let cp = lo; cp <= Math.min(hi, 127); cp++) {
      const lower = cp | 0x20;
      if (lower < 97 || lower > 122) continue;
      add(cp ^ 0x20);
      if (lower === 115) add(LONG_S);
      if (lower === 107) add(KELVIN);
    }
    if (hi < 128) continue;
    if (hi - Math.max(lo, 128) > 0x3000) throw new Error(`case folding of a wide range outside ASCII: ${lo}-${hi}`);
    for (let cp = Math.max(lo, 128); cp <= hi; cp++) {
      if (cp === LONG_S) (add(115), add(83));
      else if (cp === KELVIN) (add(107), add(75));
      else {
        const char = String.fromCodePoint(cp);
        if (char.toLowerCase() !== char || char.toUpperCase() !== char) {
          throw new Error(`case folding of U+${cp.toString(16)} is not supported`);
        }
      }
    }
  }
  return normalize(out);
}

const DIGIT: Ranges = [48, 57];
const WORD: Ranges = [48, 57, 65, 90, 95, 95, 97, 122];
/** JavaScript's `\s` (WhiteSpace and LineTerminator), the set `re2Source` gave RE2. */
const JS_SPACE: Ranges = normalize([
  9, 13, 32, 32, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000,
  0x3000, 0xfeff, 0xfeff,
]);
/** JavaScript's `.` without the `s` flag. */
const JS_DOT: Ranges = negate(normalize([10, 10, 13, 13, 0x2028, 0x2029]));
/** RE2's POSIX classes (ASCII), those the parser accepts. */
const POSIX: Record<string, Ranges> = {
  alnum: [48, 57, 65, 90, 97, 122],
  alpha: [65, 90, 97, 122],
  digit: DIGIT,
  lower: [97, 122],
  upper: [65, 90],
  word: WORD,
  xdigit: [48, 57, 65, 70, 97, 102],
};

export type Assertion = "begin" | "end" | "word" | "nonword";
/** A parsed pattern (exported for the differential tests' sampler). */
export type RegexNode =
  | { t: "set"; ranges: Ranges }
  | { t: "cat"; xs: RegexNode[] }
  | { t: "alt"; xs: RegexNode[] }
  | { t: "rep"; x: RegexNode; min: number; max: number }
  | { t: "assert"; kind: Assertion }
  | { t: "empty" };

const EMPTY: RegexNode = { t: "empty" };
/** RE2's own limit on a counted repetition. */
const MAX_REPEAT = 1000;

/** A recursive-descent parser for the RE2 subset above. */
class Parser {
  private at = 0;
  private readonly cps: number[];
  constructor(private readonly source: string) {
    this.cps = Array.from(source, (char) => char.codePointAt(0)!);
  }

  parse(): RegexNode {
    const node = this.alternation(false);
    if (this.at < this.cps.length) this.fail("unmatched )");
    return node;
  }

  private fail(why: string): never {
    throw new Error(`allowlist regex not supported (${why}): ${this.source}`);
  }

  private peek(offset = 0): number | undefined {
    return this.cps[this.at + offset];
  }

  private lookingAt(text: string): boolean {
    for (let i = 0; i < text.length; i++) if (this.cps[this.at + i] !== text.charCodeAt(i)) return false;
    return true;
  }

  /** Alternatives up to a `)` or the end. A `(?flags)` holds to the group's end, across later alternatives (Go). */
  private alternation(foldIn: boolean): RegexNode {
    let foldCase = foldIn;
    const alternatives: RegexNode[] = [];
    let concat: RegexNode[] = [];
    while (this.at < this.cps.length) {
      const char = this.peek()!;
      if (char === 41 /* ) */) break;
      if (char === 124 /* | */) {
        this.at++;
        alternatives.push(cat(concat));
        concat = [];
        continue;
      }
      const flags = this.inlineFlags();
      if (flags !== undefined) {
        if (flags.scoped) {
          const inner = this.alternation(flags.fold ?? foldCase);
          if (this.peek() !== 41) this.fail("missing )");
          this.at++;
          concat.push(this.quantified(inner));
        } else foldCase = flags.fold ?? foldCase;
        continue;
      }
      concat.push(this.quantified(this.atom(foldCase)));
    }
    alternatives.push(cat(concat));
    return alternatives.length === 1 ? alternatives[0]! : { t: "alt", xs: alternatives };
  }

  /** `(?i)`, `(?-i:`, `(?s:` and the like; undefined when the text is not a flag group. */
  private inlineFlags(): { fold?: boolean; scoped: boolean } | undefined {
    if (!this.lookingAt("(?")) return undefined;
    let i = 2;
    let on = true;
    let fold: boolean | undefined;
    for (;;) {
      const char = this.peek(i);
      if (char === undefined) this.fail("unterminated group");
      if (char === 45 /* - */ && on) on = false;
      else if (char === 105 /* i */) fold = on;
      else if (char === 115 /* s */) {
        // `.` means JavaScript's `.` with or without (?s), as re2Source rewrote it; nothing to record.
      } else if (char === 41 /* ) */ || char === 58 /* : */) {
        if (i === 2 && char === 41) this.fail("empty flag group");
        this.at += i + 1;
        return { fold, scoped: char === 58 };
      } else if (i === 2 && (char === 80 /* P */ || char === 60) /* < */) return undefined;
      else this.fail(`flag ${String.fromCodePoint(char)}`);
      i++;
    }
  }

  private atom(foldCase: boolean): RegexNode {
    const char = this.peek()!;
    switch (char) {
      case 40 /* ( */: {
        this.at++;
        if (this.lookingAt("?P<") || this.lookingAt("?<")) {
          const close = this.cps.indexOf(62 /* > */, this.at);
          if (close < 0) this.fail("unterminated group name");
          this.at = close + 1;
        } else if (this.peek() === 63 /* ? */) this.fail("group syntax");
        const inner = this.alternation(foldCase);
        if (this.peek() !== 41) this.fail("missing )");
        this.at++;
        return inner;
      }
      case 91 /* [ */:
        return this.charClass(foldCase);
      case 46 /* . */:
        this.at++;
        return { t: "set", ranges: JS_DOT };
      case 94 /* ^ */:
        this.at++;
        return { t: "assert", kind: "begin" };
      case 36 /* $ */:
        this.at++;
        return { t: "assert", kind: "end" };
      case 92 /* \ */: {
        const next = this.peek(1);
        const assertion: Record<number, Assertion> = { 65: "begin", 122: "end", 98: "word", 66: "nonword" };
        if (next !== undefined && assertion[next]) {
          this.at += 2;
          return { t: "assert", kind: assertion[next]! };
        }
        const perl = this.perlClass();
        if (perl) return { t: "set", ranges: foldCase ? perlFolded(perl) : perl.ranges };
        return literal(this.escapedChar(), foldCase);
      }
      case 42 /* * */:
      case 43 /* + */:
      case 63 /* ? */:
        this.fail("missing argument to repetition operator");
      // eslint-disable-next-line no-fallthrough
      default:
        if (char === 123 /* { */ && this.repeatSpec(this.at) !== undefined) {
          this.fail("missing argument to repetition operator");
        }
        this.at++;
        return literal(char, foldCase);
    }
  }

  /** The quantifiers after an atom: one at most, as RE2 refuses `a**`; a lazy `?` changes nothing for `test`. */
  private quantified(node: RegexNode): RegexNode {
    const char = this.peek();
    let min: number;
    let max: number;
    if (char === 42) [min, max] = [0, -1];
    else if (char === 43) [min, max] = [1, -1];
    else if (char === 63) [min, max] = [0, 1];
    else if (char === 123) {
      const spec = this.repeatSpec(this.at);
      if (!spec) return node; // a `{` that does not open a repeat is a literal (RE2), read by `atom`
      [min, max] = [spec.min, spec.max];
      this.at = spec.end - 1;
    } else return node;
    this.at++;
    if (this.peek() === 63) this.at++;
    const next = this.peek();
    if (next === 42 || next === 43 || next === 63 || (next === 123 && this.repeatSpec(this.at))) {
      this.fail("nested repetition operator");
    }
    return { t: "rep", x: node, min, max };
  }

  /** `{n}`, `{n,}` or `{n,m}` at `start`, with the index after it; undefined when it is not one. */
  private repeatSpec(start: number): { min: number; max: number; end: number } | undefined {
    let i = start + 1;
    const number = () => {
      const from = i;
      while (this.cps[i] !== undefined && this.cps[i]! >= 48 && this.cps[i]! <= 57) i++;
      return i > from ? Number(String.fromCodePoint(...this.cps.slice(from, i))) : undefined;
    };
    const min = number();
    if (min === undefined) return undefined;
    let max = min;
    if (this.cps[i] === 44 /* , */) {
      i++;
      max = number() ?? -1;
    }
    if (this.cps[i] !== 125 /* } */) return undefined;
    if (min > MAX_REPEAT || max > MAX_REPEAT || (max >= 0 && max < min)) this.fail("bad repetition count");
    return { min, max, end: i + 1 };
  }

  /** `\d`, `\w`, `\s` and their complements at the cursor (consumed); undefined otherwise. */
  private perlClass(): { ranges: Ranges; negated: boolean; base: Ranges } | undefined {
    if (this.peek() !== 92) return undefined;
    const name = this.peek(1);
    const base: Record<number, Ranges> = { 100: DIGIT, 68: DIGIT, 119: WORD, 87: WORD, 115: JS_SPACE, 83: JS_SPACE };
    if (name === undefined || !base[name]) return undefined;
    this.at += 2;
    const negated = name === 68 || name === 87 || name === 83;
    return { ranges: negated ? negate(base[name]!) : base[name]!, negated, base: base[name]! };
  }

  /** The character an escape stands for (consumed): `\n`, `\x41`, `\x{2028}`, or escaped punctuation. */
  private escapedChar(): number {
    const char = this.peek(1);
    if (char === undefined) this.fail("trailing backslash");
    this.at += 2;
    const simple: Record<number, number> = { 110: 10, 116: 9, 114: 13, 102: 12, 118: 11, 97: 7 };
    if (simple[char] !== undefined) return simple[char]!;
    if (char === 120 /* x */) {
      let digits: string;
      if (this.peek() === 123) {
        const close = this.cps.indexOf(125, this.at);
        if (close < 0) this.fail("unterminated \\x{");
        digits = String.fromCodePoint(...this.cps.slice(this.at + 1, close));
        this.at = close + 1;
      } else {
        digits = String.fromCodePoint(...this.cps.slice(this.at, this.at + 2));
        this.at += 2;
      }
      if (!/^[0-9A-Fa-f]{1,6}$/.test(digits) || parseInt(digits, 16) > MAX_CP) this.fail("bad \\x escape");
      return parseInt(digits, 16);
    }
    // Go: any ASCII punctuation may be escaped; letters and digits other than those above are errors.
    if (char < 128 && !/[0-9A-Za-z]/.test(String.fromCharCode(char))) return char;
    this.fail(`escape \\${String.fromCodePoint(char)}`);
  }

  /** A bracket class (Go's `parseClass`): ranges, `\d`/`\w`/`\s` and complements, `[:posix:]`, a leading `^`. */
  private charClass(foldCase: boolean): RegexNode {
    this.at++;
    let negated = false;
    if (this.peek() === 94) {
      negated = true;
      this.at++;
    }
    let ranges: number[] = [];
    let first = true;
    for (;;) {
      const char = this.peek();
      if (char === undefined) this.fail("missing ]");
      if (char === 93 /* ] */ && !first) break;
      first = false;
      if (this.lookingAt("[:")) {
        let close = this.at + 2;
        while (close < this.cps.length && !(this.cps[close] === 58 && this.cps[close + 1] === 93)) close++;
        const name = String.fromCodePoint(...this.cps.slice(this.at + 2, close));
        const posix = close < this.cps.length ? POSIX[name] : undefined;
        if (!posix) this.fail(`POSIX class [:${name}:]`);
        ranges.push(...(foldCase ? fold(posix) : posix));
        this.at = close + 2;
        continue;
      }
      const perl = this.perlClass();
      if (perl) {
        ranges.push(...(foldCase ? perlFolded(perl) : perl.ranges));
        continue;
      }
      const lo = this.classChar();
      let hi = lo;
      if (this.peek() === 45 /* - */ && this.peek(1) !== undefined && this.peek(1) !== 93) {
        this.at++;
        hi = this.classChar();
        if (hi < lo) this.fail("bad character class range");
      }
      ranges.push(...(foldCase ? fold([lo, hi]) : [lo, hi]));
    }
    this.at++;
    ranges = normalize(ranges);
    return { t: "set", ranges: negated ? negate(ranges) : ranges };
  }

  private classChar(): number {
    const char = this.peek()!;
    if (char === 92) return this.escapedChar();
    this.at++;
    return char;
  }
}

/** A Perl class under `(?i)`: Go folds the positive class, then negates (`(?i)\W` excludes U+017F and U+212A). */
function perlFolded(perl: { negated: boolean; base: Ranges }): Ranges {
  const folded = fold(perl.base);
  return perl.negated ? negate(folded) : folded;
}

function literal(cp: number, foldCase: boolean): RegexNode {
  return { t: "set", ranges: foldCase ? fold([cp, cp]) : [cp, cp] };
}

function cat(xs: RegexNode[]): RegexNode {
  const kept = xs.filter((x) => x.t !== "empty");
  return kept.length === 0 ? EMPTY : kept.length === 1 ? kept[0]! : { t: "cat", xs: kept };
}

// NFA node kinds.
const CHAR = 0;
const SPLIT = 1;
const ASSERT = 2;
const MATCH = 3;
const ASSERT_CODES: Record<Assertion, number> = { begin: 0, end: 1, word: 2, nonword: 3 };
/** A bound on the NFA, so a pattern with large counted repetitions cannot make every closure slow. */
const MAX_NODES = 20_000;

/** A Thompson NFA, built back to front so each fragment is given its continuation. */
class Nfa {
  readonly kind: number[] = [];
  readonly out1: number[] = [];
  readonly out2: number[] = [];
  /** CHAR: index into `sets`; ASSERT: assertion code. */
  readonly arg: number[] = [];
  readonly sets: Ranges[] = [];
  private readonly setIds = new Map<string, number>();
  readonly start: number;

  constructor(root: RegexNode) {
    const match = this.add(MATCH, -1, -1, 0);
    this.start = this.compile(root, match);
  }

  private add(kind: number, out1: number, out2: number, arg: number): number {
    if (this.kind.length >= MAX_NODES) throw new Error("allowlist regex too large for the automaton");
    this.kind.push(kind);
    this.out1.push(out1);
    this.out2.push(out2);
    this.arg.push(arg);
    return this.kind.length - 1;
  }

  private set(ranges: Ranges): number {
    const key = ranges.join(",");
    let id = this.setIds.get(key);
    if (id === undefined) {
      id = this.sets.length;
      this.sets.push(ranges);
      this.setIds.set(key, id);
    }
    return id;
  }

  private compile(node: RegexNode, next: number): number {
    switch (node.t) {
      case "empty":
        return next;
      case "set":
        return this.add(CHAR, next, -1, this.set(node.ranges));
      case "assert":
        return this.add(ASSERT, next, -1, ASSERT_CODES[node.kind]);
      case "cat":
        for (let i = node.xs.length - 1; i >= 0; i--) next = this.compile(node.xs[i]!, next);
        return next;
      case "alt": {
        let entry = this.compile(node.xs[node.xs.length - 1]!, next);
        for (let i = node.xs.length - 2; i >= 0; i--)
          entry = this.add(SPLIT, this.compile(node.xs[i]!, next), entry, 0);
        return entry;
      }
      case "rep": {
        let entry = next;
        if (node.max < 0) {
          const loop = this.add(SPLIT, -1, next, 0);
          this.out1[loop] = this.compile(node.x, loop);
          entry = loop;
        } else {
          for (let i = 0; i < node.max - node.min; i++) entry = this.add(SPLIT, this.compile(node.x, entry), next, 0);
        }
        for (let i = 0; i < node.min; i++) entry = this.compile(node.x, entry);
        return entry;
      }
    }
  }
}

/** The result of a step: a state index, or one of these. */
const UNKNOWN = -1;
const MATCHED = -2;
const DEAD = -3;
/**
 * DFA states kept per pattern before the cache is dropped and rebuilt (RE2 does the same): it bounds memory on
 * crafted input, and time stays linear, a rebuilt state costing one closure.
 */
const MAX_STATES = 2_000;

interface State {
  kernel: Int32Array;
  prevWord: boolean;
  atStart: boolean;
  next: Int32Array;
  /** Whether the text may end here: -1 unknown, 0 no, 1 yes. */
  atEnd: number;
}

const isWordCp = (cp: number) =>
  (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || cp === 95 || (cp >= 97 && cp <= 122);

/** Whether a regex occurs in a text: one pass, linear in the text. */
export interface Tester {
  test(text: string): boolean;
}

/** A lazily built DFA for one pattern: unanchored search, `test` only. */
class Dfa implements Tester {
  private readonly nfa: Nfa;
  /** Code point classes: `bounds[i]` is the first code point of class i; every set is a union of classes. */
  private readonly bounds: Int32Array;
  private readonly asciiClass = new Uint8Array(128);
  private readonly classWord: Uint8Array;
  /** Per NFA set, per class: whether the set holds the class. */
  private readonly accepts: Uint8Array[];
  /** A pattern that can only match from the text's start (each path from the start asserts `^` first). */
  private readonly anchored: boolean;
  private states: State[] = [];
  private ids = new Map<string, number>();
  private initial = -1;
  private readonly mark: Int32Array;
  private generation = 0;

  constructor(root: RegexNode) {
    this.nfa = new Nfa(root);
    const cuts = new Set<number>([0, 48, 58, 65, 91, 95, 96, 97, 123, 128]);
    for (const ranges of this.nfa.sets) {
      for (let i = 0; i < ranges.length; i += 2) {
        cuts.add(ranges[i]!);
        if (ranges[i + 1]! < MAX_CP) cuts.add(ranges[i + 1]! + 1);
      }
    }
    this.bounds = Int32Array.from([...cuts].sort((a, b) => a - b));
    this.classWord = Uint8Array.from(this.bounds, (cp) => (isWordCp(cp) ? 1 : 0));
    for (let cp = 0; cp < 128; cp++) this.asciiClass[cp] = this.classOf(cp);
    this.accepts = this.nfa.sets.map((ranges) => Uint8Array.from(this.bounds, (cp) => (contains(ranges, cp) ? 1 : 0)));
    this.mark = new Int32Array(this.nfa.kind.length);
    this.anchored = this.isAnchored();
  }

  private classOf(cp: number): number {
    let lo = 0;
    let hi = this.bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bounds[mid]! <= cp) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The epsilon closure of `kernel` between two characters: assertions are decided by the context (`prevWord`,
   * `atStart`; the next character's word-ness `nextWord`; `atEnd`). Returns MATCHED when the match state is in it,
   * else fills `chars` with its character nodes.
   */
  private closure(
    kernel: ArrayLike<number>,
    atStart: boolean,
    prevWord: boolean,
    nextWord: boolean,
    atEnd: boolean,
    chars: number[],
  ): number {
    const { kind, out1, out2, arg } = this.nfa;
    const generation = ++this.generation;
    const stack: number[] = [];
    for (let i = kernel.length - 1; i >= 0; i--) stack.push(kernel[i]!);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.mark[node] === generation) continue;
      this.mark[node] = generation;
      switch (kind[node]) {
        case MATCH:
          return MATCHED;
        case CHAR:
          chars.push(node);
          break;
        case SPLIT:
          stack.push(out2[node]!, out1[node]!);
          break;
        case ASSERT: {
          const code = arg[node]!;
          const holds =
            code === 0 ? atStart : code === 1 ? atEnd : code === 2 ? prevWord !== nextWord : prevWord === nextWord;
          if (holds) stack.push(out1[node]!);
          break;
        }
      }
    }
    return 0;
  }

  private isAnchored(): boolean {
    for (const prevWord of [false, true]) {
      for (const nextWord of [false, true]) {
        for (const atEnd of [false, true]) {
          const chars: number[] = [];
          if (this.closure([this.nfa.start], false, prevWord, nextWord, atEnd, chars) === MATCHED) return false;
          if (chars.length > 0) return false;
        }
      }
    }
    return true;
  }

  private intern(kernel: number[], atStart: boolean, prevWord: boolean): number {
    const key = `${atStart ? 1 : 0}${prevWord ? 1 : 0}:${kernel.join(",")}`;
    let id = this.ids.get(key);
    if (id !== undefined) return id;
    if (this.states.length >= MAX_STATES) {
      this.states = [];
      this.ids = new Map();
      this.initial = -1;
    }
    id = this.states.length;
    this.states.push({
      kernel: Int32Array.from(kernel),
      prevWord,
      atStart,
      next: new Int32Array(this.bounds.length).fill(UNKNOWN),
      atEnd: -1,
    });
    this.ids.set(key, id);
    return id;
  }

  private step(id: number, cls: number): number {
    const state = this.states[id]!;
    const chars: number[] = [];
    const nextWord = this.classWord[cls] === 1;
    let result: number;
    if (this.closure(state.kernel, state.atStart, state.prevWord, nextWord, false, chars) === MATCHED) result = MATCHED;
    else {
      const kernel: number[] = [];
      const { out1, arg } = this.nfa;
      for (const node of chars) if (this.accepts[arg[node]!]![cls] === 1) kernel.push(out1[node]!);
      if (!this.anchored) kernel.push(this.nfa.start);
      if (kernel.length === 0) result = DEAD;
      else {
        const unique = [...new Set(kernel)].sort((a, b) => a - b);
        result = this.intern(unique, false, nextWord);
      }
    }
    // The cache may have been dropped by `intern`; then `state` is no longer in it and caching is moot.
    if (this.states[id] === state) state.next[cls] = result;
    return result;
  }

  test(text: string): boolean {
    if (this.initial < 0 || this.states[this.initial] === undefined)
      this.initial = this.intern([this.nfa.start], true, false);
    let id = this.initial;
    const length = text.length;
    for (let i = 0; i < length;) {
      let cp = text.charCodeAt(i++);
      let cls: number;
      if (cp < 128) cls = this.asciiClass[cp]!;
      else {
        if (cp >= 0xd800 && cp <= 0xdbff && i < length) {
          const low = text.charCodeAt(i);
          if (low >= 0xdc00 && low <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
            i++;
          }
        }
        cls = this.classOf(cp);
      }
      let next = this.states[id]!.next[cls]!;
      if (next === UNKNOWN) next = this.step(id, cls);
      if (next === MATCHED) return true;
      if (next === DEAD) return false;
      id = next;
    }
    const state = this.states[id]!;
    if (state.atEnd < 0) {
      state.atEnd = this.closure(state.kernel, state.atStart, state.prevWord, false, true, []) === MATCHED ? 1 : 0;
    }
    return state.atEnd === 1;
  }
}

/** The pattern's text when it is a plain string (each element one code point, no case folding), else undefined. */
function literalText(node: RegexNode): string | undefined {
  const parts = node.t === "cat" ? node.xs : [node];
  let out = "";
  for (const part of parts) {
    if (part.t !== "set" || part.ranges.length !== 2 || part.ranges[0] !== part.ranges[1]) return undefined;
    out += String.fromCodePoint(part.ranges[0]!);
  }
  return out;
}

/**
 * Compiles a gitleaks (Go/RE2) allowlist regex. A plain string (a fixed key gitleaks excuses, `--mount=type=secret,`)
 * is an `includes`, as fast as it gets; anything else is a `Dfa`. Throws on syntax outside the subset.
 */
export function compileAllowlistRegex(goPattern: string): Tester {
  const root = parseRegex(goPattern);
  const text = literalText(root);
  if (text !== undefined && text.length > 0) return { test: (input) => input.includes(text) };
  return new Dfa(root);
}

/** Parses a pattern of the subset (throws outside it). */
export function parseRegex(goPattern: string): RegexNode {
  return new Parser(goPattern).parse();
}
