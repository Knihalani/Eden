/**
 * D24: the gitleaks rules run on RE2 (re2js), linear in the text, with results identical to JavaScript's own
 * backtracking engine on the gate's inputs. That no input makes the gate super-linear is tested in redos.test.ts.
 * Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import gitleaks from "./vendor/gitleaks/gitleaks.toml";
import {
  backtrackingEngine,
  everywhere,
  linearEngine,
  re2Source,
  rulesWith,
  secretRules,
  URL_USERINFO,
} from "./secrets";

/** mulberry32: a seeded generator, so a failure names a reproducible text. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SEPARATORS = [" ", "\n", "\r\n", ". ", "\t", "\u00a0", "\u2028", " 😀 "];

/** Every gitleaks keyword in assignment shapes, provider shapes, and prose, joined by ASCII and Unicode spaces. */
function corpus(seed: number, count: number): string[] {
  const rnd = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const draw = (alphabet: string, n: number) =>
    Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  const rules = (gitleaks as { rules: { keywords?: string[] }[] }).rules;
  const keywords = [...new Set(rules.flatMap((rule) => rule.keywords ?? []))];
  const value = () => draw(pick([ALNUM, "0123456789abcdef", ALNUM + "-_", ALNUM + "+/"]), pick([8, 16, 24, 32, 40]));
  const shapes: (() => string)[] = [
    () => `${pick(keywords)}_key = "${value()}"`,
    () => `${pick(keywords).toUpperCase()}_TOKEN=${value()}`,
    () => `"${pick(keywords)}": "${value()}"`,
    () => `${pick(keywords)}${value()}`,
    () => `${pick(keywords)}: ${value()},`,
    () => `curl -H "Authorization: Bearer ${value()}" https://api.example.com`,
    () => `curl -u admin:${value()} https://x.example.com`,
    () => `postgres://admin:${value()}@db.internal:5432/app`,
    () => `${"e" + "yJ"}${draw(ALNUM, 30)}.${"e" + "yJ"}${draw(ALNUM, 40)}.${draw(ALNUM, 43)}`,
    () => `-----${"BEGIN " + "PRIVATE KEY"}-----\n${draw(ALNUM + "+/", 64)}\n-----${"END " + "PRIVATE KEY"}-----`,
    () => `${"AK" + "IA"}${draw("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`,
    () => `${"AI" + "za"}${draw(ALNUM + "-_", 35)}`,
    () => "Müller’s café booking for Zoë on Thursday; the access review is due Friday.",
  ];
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(shapes)()).join(pick(SEPARATORS)),
  );
}

describe("RE2 for the gitleaks rules", () => {
  test("every rule and allowlist regex compiles after re2Source", () => {
    for (const rule of rulesWith(everywhere(linearEngine))) expect(() => rule.spans("")).not.toThrow();
    const config = gitleaks as {
      allowlist: { regexes?: string[] };
      rules: { allowlists?: { regexes?: string[] }[] }[];
    };
    const allowlists = [config.allowlist, ...config.rules.flatMap((rule) => rule.allowlists ?? [])];
    for (const source of allowlists.flatMap((list) => list.regexes ?? []))
      expect(() => linearEngine(source)).not.toThrow();
  });

  test("re2Source gives \\s and . JavaScript's meaning", () => {
    const space = linearEngine(String.raw`a\sb`);
    expect(space.test("a\u00a0b")).toBe(true);
    expect(space.test("a\u2028b")).toBe(true);
    const dot = linearEngine("a.b");
    expect(dot.test("a\rb")).toBe(false);
    expect(dot.test("a\u2029b")).toBe(false);
    expect(dot.test("a😀b")).toBe(true);
    expect(re2Source(String.raw`[\s\S-]`)).toContain(String.raw`\S`);
    expect(() => re2Source(String.raw`[a\S]`)).toThrow("alone in a class");
  });

  test("on RE2, every rule finds the same spans as on JavaScript's engine", () => {
    const linear = rulesWith(everywhere(linearEngine));
    const reference = rulesWith(everywhere(backtrackingEngine));
    let found = 0;
    for (const text of corpus(17, 400)) {
      for (let r = 0; r < linear.length; r++) {
        const spans = linear[r]!.spans(text);
        found += spans.length;
        expect([reference[r]!.id, ...spans.flat()]).toEqual([reference[r]!.id, ...reference[r]!.spans(text).flat()]);
      }
    }
    expect(found).toBeGreaterThan(400); // the corpus exercises the rules, not only prose
    // About 4 s alone; Bun's 5 s default is too tight when the parallel test run shares the cores.
  }, 30_000);

  test("Unicode case folding only ever adds findings (RE2 folds s with U+017F)", () => {
    const text = `api_key = "${"aB3dE5gH7jK9mN2pQ4sT6vW8yZ"}${"x".repeat(6)}"`.replace("api", "api\u017f");
    const ids = (rules: ReturnType<typeof rulesWith>) =>
      rules.filter((rule) => rule.spans(text).length).map((r) => r.id);
    const reference = ids(rulesWith(everywhere(backtrackingEngine)));
    const linear = ids(secretRules());
    for (const id of reference) expect(linear).toContain(id);
  });
});

describe("eden-url-userinfo", () => {
  const BEFORE = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\[REDACTED\]@)([^\s/@]+)@`, "dgi");
  const spans = (regex: RegExp, text: string) => [...text.matchAll(regex)].map((found) => found.indices![1]);

  test("the lookbehind form finds exactly what the old form found", () => {
    const rnd = prng(5);
    const parts = ["a", "-", ".", "+", "://", ":", "@", "/", " ", "x1", "[REDACTED]", "\n", "B", "ftp", "h", "é"];
    let hits = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = Array.from({ length: 4 + Math.floor(rnd() * 40) }, () => parts[Math.floor(rnd() * parts.length)])
        .join("")
        .concat(rnd() < 0.3 ? `postgres://u:${i}x@h` : "");
      const expected = spans(BEFORE, text);
      hits += expected.length;
      expect(spans(URL_USERINFO, text)).toEqual(expected);
    }
    expect(hits).toBeGreaterThan(1_000);
  });
});
