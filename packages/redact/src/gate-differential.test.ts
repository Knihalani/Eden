/**
 * The gate made faster (docs/research/redact-perf.md) finds exactly what the gate before it found: the reference
 * (`secrets.reference.ts`, `redact.reference.ts`, the primitives' `matcher.reference.ts`) is that gate, kept unchanged
 * as the oracle. A seeded fuzz over every rule's regex and Eden's shapes, the eval scenarios' texts and the crafted
 * inputs, compared rule by rule (ids and spans), `secretHits`, `sanitizeForStore`, `redactString` and `redact`; then
 * the pieces the speed-ups rest on. The full fuzz (1,000,000 texts) is `bun packages/redact/src/gate-differential.ts`.
 * Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchoredRegex, anchorsOf, anchorsOfRegex, Occurrences } from "./anchor.ts";
import { parseRegex } from "./automaton.ts";
import { prng, sample } from "./differential.ts";
import { CRAFTED_UNITS, crafted } from "./gate-crafted.ts";
import { difference, fuzzGate } from "./gate-differential.ts";
import { assignmentSpans, redactString, TOKEN_PASSES } from "./redact.ts";
import { assignmentSpans as assignmentSpansBefore, redactString as redactStringBefore } from "./redact.reference.ts";
import { isSpace, URL_USERINFO } from "./secrets.ts";

describe("the gate against the reference gate", () => {
  test("a seeded fuzz of 4,000 texts: identical findings, hits, stored text and redaction", () => {
    const result = fuzzGate(4_000, 20261114);
    expect(result.failures).toEqual([]);
    // Most texts hold something a rule finds, so spans are compared, not only empty results.
    expect(result.withFindings).toBeGreaterThan(2_000);
  }, 30_000);

  test("every text of the eval scenarios", () => {
    const texts: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    const root = join(import.meta.dir, "../../eval/scenarios");
    for (const dir of [root, join(root, "acting")]) {
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
});
