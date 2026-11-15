/**
 * The gate made faster (docs/research/redact-perf.md) finds exactly what the gate before it found: the reference
 * (`secrets.reference.ts`, `redact.reference.ts`, the primitives' `matcher.reference.ts`) is that gate, kept unchanged
 * as the oracle. A seeded fuzz over every rule's regex and Eden's shapes, the eval scenarios' texts and the crafted
 * inputs, compared rule by rule (ids and spans), `secretHits`, `sanitizeForStore`, `redactString` and `redact`; then
 * the pieces the speed-ups rest on. The full fuzz (1,000,000 texts) is `bun packages/redact/src/gate-differential.ts`.
 * Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnchoredRegex,
  analyseAnchors,
  anchorsOf,
  anchorsOfRegex,
  lazyPrefixOf,
  Occurrences,
  topLevelBranches,
} from "./anchor.ts";
import { parseRegex } from "./automaton.ts";
import { prng, sample } from "./differential.ts";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { difference, fuzzGate } from "./gate-differential.ts";
import { assignmentSpans, redactString, TOKEN_PASSES } from "./redact.ts";
import { assignmentSpans as assignmentSpansBefore, redactString as redactStringBefore } from "./redact.reference.ts";
import generated from "./rules.generated.json" with { type: "json" };
import { goRegex, isSpace, LAZY_PREFIX, LINEAR_RULES, URL_USERINFO } from "./secrets.ts";

describe("the gate against the reference gate", () => {
  test("a seeded fuzz of 4,000 texts: identical findings, hits, stored text and redaction", () => {
    const result = fuzzGate(4_000, 20261114);
    expect(result.failures).toEqual([]);
    // Most texts hold something a rule finds, so spans are compared, not only empty results.
    expect(result.withFindings).toBeGreaterThan(2_000);
  }, 30_000);

  // In the Eden repository; skipped where the package stands alone.
  const scenarios = join(import.meta.dir, "../../eval/scenarios");
  test.skipIf(!existsSync(scenarios))("every text of the eval scenarios", () => {
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    for (const dir of [scenarios, join(scenarios, "acting")]) {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        walk(JSON.parse(readFileSync(join(dir, name), "utf8")));
      }
    }
    expect(texts.length).toBeGreaterThan(500);
    for (const text of texts) expect(difference(text)).toBeUndefined();
    expect(difference(texts.join("\n"))).toBeUndefined();
  });

  test("the crafted inputs at 16 KB", () => {
    for (const [, unit] of CRAFTED_UNITS) expect(difference(crafted(unit, 16_384))).toBeUndefined();
  }, 30_000);
});

describe("what the speed-ups rest on", () => {
  test("isSpace is JavaScript's \\s on every code unit", () => {
    for (let c = 0; c < 65_536; c++) expect(isSpace(c)).toBe(/\s/.test(String.fromCharCode(c)));
  });

  test("the assignment pass reads keys as the memoised isSecretKey did, on random keys", () => {
    const rnd = prng(5);
    const nouns = ["apikey", "accesskey", "secret", "token", "authorization", "credentials", "auth", "jwt", "cookie"];
    const parts = [...nouns, "s", "1", "_", ".", "-", "x", "author", "izer", "monkey", "S", "Token", "KEY", "9"];
    for (let i = 0; i < 3_000; i++) {
      let key = "";
      for (let n = 1 + Math.floor(rnd() * 4); n > 0; n--) key += parts[Math.floor(rnd() * parts.length)];
      if (rnd() < 0.3) key = key.toUpperCase();
      const text = `${key}${rnd() < 0.5 ? "=" : ": "}v4lue-${i} ${key}:"q,${i}" n=1`;
      expect(assignmentSpans(text)).toEqual(assignmentSpansBefore(text));
      expect(redactString(text)).toBe(redactStringBefore(text));
    }
  });

  test("every match of a token pass holds one of that pass's literals (sampled from each regex)", () => {
    const rnd = prng(9);
    for (const { regexes, literals } of TOKEN_PASSES)
      for (const regex of regexes) {
        // The lookahead (Basic credentials) is dropped for sampling; what it excludes needs no literal.
        const source = regex.source.replace(/\(\?![^)]*\)/g, "");
        const node = parseRegex(`(?i)${source}`);
        let matched = 0;
        for (let i = 0; i < 300; i++) {
          const text = sample(rnd, node);
          const found = new RegExp(regex.source, "gi").exec(` ${text} `);
          if (!found) continue;
          matched++;
          const lower = found[0].toLowerCase();
          expect(literals.some((word) => lower.includes(word))).toBe(true);
        }
        expect(matched).toBeGreaterThan(100);
      }
  });

  test("anchors: the keyword-assignment shape, a top-level alternation, a regex's lookarounds dropped", () => {
    const generic = anchorsOf(String.raw`(?i)[\w.-]{0,50}?(?:access|auth|(?-i:[Aa]pi|API)|key)(?:[ \t\w.-]{0,20})=`)!;
    expect(generic.length).toBe(1);
    expect(generic[0]!.maxPrefix).toBe(50);
    expect(generic[0]!.literals.sort()).toEqual(["access", "api", "auth", "key"]);
    expect(generic[0]!.prefix["a".charCodeAt(0)]).toBe(1);
    expect(generic[0]!.prefix[" ".charCodeAt(0)]).toBe(0);
    const two = anchorsOf(String.raw`(?i)[\w.-]{0,50}?(?:jira)=x|\b(ATATT3[A-Za-z0-9]{10})`)!;
    expect(two.map((a) => [a.literals, a.maxPrefix])).toEqual([
      [["jira=x"], 50], // a group in a concatenation is spliced in, so the literal runs on
      [["atatt3"], 0],
    ]);
    // An unbounded prefix, or one alternative without a literal, means no anchors: the rule scans as before.
    expect(anchorsOf(String.raw`[a-z]+secret`)).toBeUndefined();
    expect(anchorsOf(String.raw`ghp_[a-z]{4}|[0-9]{8}`)).toBeUndefined();
    // A class with a character the prefilter does not fold to its letter is no literal character: it joins the prefix.
    expect(anchorsOf("[aé]bcd")!.map((a) => [a.literals, a.maxPrefix])).toEqual([[["bcd"], 1]]);
    expect(anchorsOf("(?i)secret")!.map((a) => a.literals)).toEqual([["secret"]]); // U+017F folds to s
    // A character outside the BMP is two code units to JavaScript (no `u` flag), so it counts twice.
    expect(anchorsOf("x?😀{0,3}token")![0]!.maxPrefix).toBe(1 + 6);
    expect(anchorsOfRegex(URL_USERINFO)!.map((a) => a.literals)).toEqual([["://"]]);
    expect(anchorsOfRegex(/(?<!x)(?=abc)abcdef(?!g)/)!.map((a) => a.literals)).toEqual([["abcdef"]]);
  });

  test("an anchored regex reports matchAll's matches, and falls back when candidates are dense", () => {
    const regex = /[a-z]{0,3}key=(\d+)/gi;
    const anchored = new AnchoredRegex(regex, anchorsOfRegex(regex)!);
    const ids = Int32Array.from(anchored.words, (_, i) => i);
    const rnd = prng(3);
    for (let i = 0; i < 500; i++) {
      let text = "";
      for (let n = Math.floor(rnd() * 12); n > 0; n--)
        text += ["key=", "aakey=1", "KEY=12 ", "x", " ", "ke"][Math.floor(rnd() * 6)];
      const found = new Occurrences(1);
      for (let at = text.toLowerCase().indexOf("key"); at >= 0; at = text.toLowerCase().indexOf("key", at + 1)) {
        found.add(0, at);
      }
      const seen: string[] = [];
      const tried = anchored.each(text, found, ids, (m) => seen.push(`${m.index}:${m[0]}`));
      const expected = [...text.matchAll(regex)].map((m) => `${m.index}:${m[0]}`);
      if (tried) expect(seen).toEqual(expected);
      else expect(seen).toEqual([]); // dense: nothing called, the caller scans
    }
    const dense = "key=1".repeat(2_000);
    const found = new Occurrences(1);
    for (let at = 0; at < dense.length; at += 5) found.add(0, at);
    expect(anchored.each(dense, found, ids, () => {})).toBe(false);
  });

  test("a literal past the dense limit leaves `keep` for the text, and comes back for the next", () => {
    const found = new Occurrences(2, Uint8Array.of(1, 0));
    found.clear(100); // the limit: 100 / 128 + 64 = 64
    for (let at = 0; at < 64; at++) found.add(0, at);
    expect([found.complete(0), found.keep[0]]).toEqual([true, 1]);
    found.add(0, 64);
    expect([found.complete(0), found.keep[0], found.keep[1]]).toEqual([false, 0, 0]);
    found.clear(100);
    expect([found.complete(0), found.keep[0], found.count[0]]).toEqual([true, 1, 0]);
  });

  test("JavaScript's [\\w.-] is the lazy prefix's table on every code unit, case folded or not", () => {
    const lazy = lazyPrefixOf(String.raw`(?i)[\w.-]{0,50}?(?:key)=x`, () => /[\w.-]{0,50}?(?:key)=x/i)!;
    // The scan reads the table through a match: a prefix character before `key=x` joins the match, any other not.
    for (let c = 0; c < 65_536; c++) {
      const text = `${String.fromCharCode(c)}key=x`;
      for (const flags of ["", "i"]) {
        const expected = new RegExp(String.raw`[\w.-]`, flags).test(String.fromCharCode(c)) ? 0 : 1;
        const seen: number[] = [];
        lazy.each(text, undefined, undefined, (start) => seen.push(start));
        expect([c, seen]).toEqual([c, [expected]]);
      }
    }
  });

  test("top-level branches split as the parse does, in Go's syntax and JavaScript's", () => {
    expect(topLevelBranches(String.raw`a(b|c)[|\]]|d[[:alpha:]|]|\|e`)).toEqual([
      String.raw`a(b|c)[|\]]`,
      String.raw`d[[:alpha:]|]`,
      String.raw`\|e`,
    ]);
    expect(topLevelBranches("[]|]x|y")).toEqual(["[]|]x", "y"]);
  });

  test("every lazy-prefix rule reports matchAll's matches: with occurrences, without, and dense", () => {
    const config = generated.gitleaks as { rules: { id: string; regex?: string }[] };
    const rnd = prng(17);
    let rules = 0;
    let matched = 0;
    for (const rule of config.rules) {
      if (!rule.regex || LINEAR_RULES.has(rule.id) || !LAZY_PREFIX.test(rule.regex)) continue;
      const lazy = lazyPrefixOf(rule.regex, () => goRegex(rule.regex!))!;
      expect([rule.id, lazy !== undefined]).toEqual([rule.id, true]);
      rules++;
      const js = goRegex(rule.regex);
      const scan = new RegExp(js.source, js.flags + "g");
      const node = parseRegex(rule.regex);
      const pieces = [...lazy.words, "a", "-", ".", "_", "0", " ", "=", ":", "'", '"', "\n", "\\n", "x9Y", "K"];
      const texts: string[] = [];
      for (let i = 0; i < 60; i++) {
        let text = "";
        for (let n = 1 + Math.floor(rnd() * 8); n > 0; n--) {
          const r = rnd();
          let piece = r < 0.35 ? sample(rnd, node) : pieces[Math.floor(rnd() * pieces.length)]!;
          if (rnd() < 0.2) piece = piece.toUpperCase();
          text += r < 0.5 && rnd() < 0.3 ? piece.repeat(1 + Math.floor(rnd() * 5)) : piece;
        }
        texts.push(text);
      }
      // Dense in one keyword: its occurrences pass the limit and are found by the rule itself, in a window that moves
      // (more than the scratch's 256 entries).
      texts.push(`${lazy.words[0]}=`.repeat(1_200) + sample(rnd, node));
      for (const text of texts) {
        const expected = [...text.matchAll(scan)].map((m) => [m.index, m.index + m[0].length]);
        matched += expected.length;
        const without: number[][] = [];
        lazy.each(text, undefined, undefined, (start, end) => without.push([start, end]));
        expect([rule.id, text, without]).toEqual([rule.id, text, expected]);
        // The occurrences as the gate's prefilter records them (case folded), in a fresh list per text.
        const found = new Occurrences(lazy.words.length);
        found.clear(text.length);
        const lower = text.toLowerCase();
        lazy.words.forEach((word, id) => {
          for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + 1)) found.add(id, at);
        });
        const ids = Int32Array.from(lazy.words, (_, i) => i);
        const withFound: number[][] = [];
        lazy.each(text, found, ids, (start, end) => withFound.push([start, end]));
        expect([rule.id, text, withFound]).toEqual([rule.id, text, expected]);
      }
    }
    expect(rules).toBe(96);
    expect(matched).toBeGreaterThan(2_000);
  }, 60_000);

  test("analyses read from the generated tables are the ones worked out now", () => {
    const tables = generated.analyses as { anchors: Record<string, unknown>; lazy: Record<string, unknown> };
    for (const [pattern, data] of Object.entries(tables.anchors)) {
      expect([pattern, analyseAnchors(pattern)]).toEqual([pattern, data as never]);
    }
    expect(Object.keys(tables.lazy).length).toBe(95); // 96 rules: bittrex-access-key and -secret-key share one regex
    // The four rules D1841 left unanchored: two now anchored, two still scanning (the reasons are
    // in docs/research/redact-vs-alternatives.md).
    const rules = (generated.gitleaks as { rules: { id: string; regex?: string }[] }).rules;
    const anchored = (id: string) => tables.anchors[rules.find((rule) => rule.id === id)!.regex!] !== null;
    expect(["azure-ad-client-secret", "slack-webhook-url"].map(anchored)).toEqual([true, true]);
    expect(["facebook-access-token", "sourcegraph-access-token"].map(anchored)).toEqual([false, false]);
  });
});
