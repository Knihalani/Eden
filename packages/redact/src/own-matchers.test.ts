/**
 * D1705: the gate's own matchers (scanners.ts for the seven rules that backtrack in JavaScript, automaton.ts for every
 * allowlist regex) against re2js, the gate D24 shipped: exact on every character class, on seeded fuzz texts and on
 * whole-gate output (own-matchers-linear.test.ts holds them linear in CPU time on crafted input). The full fuzz
 * (50,000 texts a matcher) is `bun packages/redact/src/differential.ts`. Secret-shaped values are assembled from
 * parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileAllowlistRegex } from "./automaton.ts";
import { allowlistRegexes, fuzzAllowlist, fuzzRule, prng, ruleText } from "./differential.ts";
import { D24_ENGINES, linearEngine } from "./re2-oracle.ts";
import { SCANNER_CLASSES, SCANNERS } from "./scanners.ts";
import { GATE_ENGINES, gateOf, LINEAR_RULES, rulesWith, scannerEngine } from "./secrets.ts";
import { generate } from "./generate.ts";
import generated from "./rules.generated.json" with { type: "json" };
import gitleaks from "./vendor/gitleaks/gitleaks.toml";

/** Every BMP code point (lone surrogates included) and a sample of astral ones. */
const CODE_POINTS = [...Array.from({ length: 0x10000 }, (_, cp) => cp), 0x1f600, 0x10000, 0x1d400, 0xe0041, 0x10ffff];

describe("the scanned rules", () => {
  test("are exactly the seven, each written for the vendored regex", () => {
    expect([...LINEAR_RULES].sort()).toEqual([
      "cisco-meraki-api-key",
      "cohere-api-token",
      "curl-auth-header",
      "curl-auth-user",
      "okta-access-token",
      "privateai-api-token",
      "sumologic-access-id",
    ]);
    const rules = (gitleaks as { rules: { id: string; regex?: string }[] }).rules;
    for (const [id, scanner] of SCANNERS) expect(rules.find((rule) => rule.id === id)?.regex).toBe(scanner.regex);
  });

  test("a changed regex is refused, never matched with the old scanner", () => {
    const regex = SCANNERS.get("curl-auth-user")!.regex;
    expect(() => scannerEngine("curl-auth-user")(regex.replace("{3,}", "{2,}"))).toThrow("no matcher");
    expect(() => scannerEngine("not-a-rule")(regex)).toThrow("no matcher");
  });

  test("a vendored config the gate cannot run exactly stops it building (the review)", () => {
    type Rule = { id: string; regex?: string; allowlists?: { regexes?: string[] }[] };
    // The config the gate builds from (the TOML as JSON); its allowlist regexes are checked when `generate.ts` writes
    // it, so the TOML's own copy is the one refused there.
    const rules = (generated.gitleaks as { rules: Rule[] }).rules;
    /** Changes one field of the vendored config for the length of `check`, then puts it back. */
    const mutated = (change: () => () => void, check: () => void) => {
      const restore = change();
      try {
        check();
      } finally {
        restore();
      }
    };
    // A scanned rule's regex changed by a gitleaks update.
    const curl = rules.find((rule) => rule.id === "curl-auth-user")!;
    mutated(
      () => {
        const was = curl.regex;
        curl.regex = was!.replace("{3,}", "{2,}");
        return () => (curl.regex = was);
      },
      () => expect(() => rulesWith(GATE_ENGINES)).toThrow("curl-auth-user changed"),
    );
    // One rule's own allowlist regex in syntax the automaton lacks: refused when the config is generated, not when
    // the rule first finds something.
    const aws = (gitleaks as { rules: Rule[] }).rules.find((rule) => rule.id === "aws-access-token")!;
    const list = aws.allowlists![0]!.regexes!;
    mutated(
      () => {
        const was = list[0]!;
        list[0] = "(?m).+EXAMPLE$";
        return () => (list[0] = was);
      },
      () => expect(() => generate()).toThrow("not supported"),
    );
    expect(() => rulesWith(GATE_ENGINES)).not.toThrow();
  });

  test("every character class a scanner tests is RE2's, on every code point", () => {
    for (const [source, own] of Object.entries(SCANNER_CLASSES)) {
      const oracle = linearEngine(`^${source}$`);
      const wrong = CODE_POINTS.filter((cp) => oracle.test(String.fromCodePoint(cp)) !== own(cp));
      expect([source, wrong.slice(0, 5)]).toEqual([source, []]);
    }
  });

  test("the curl rules reach an option across 0-8 lines, as re2js does (the regex allows 1-5 more)", () => {
    const separators = ["\n", "\r", "\r\n", "\n\n", "\r\r\n", "\n\r\n", "\r\n\r\n", "\u2028"];
    const options = [" -u abc:def", " -H 'Token: abcdefghij'", '\n-u "abc:def"', '\r--header "X-Api-Key: abcdefghij"'];
    for (const id of ["curl-auth-user", "curl-auth-header"]) {
      const scanner = SCANNERS.get(id)!;
      const oracle = linearEngine(scanner.regex);
      for (let lines = 0; lines <= 8; lines++) {
        for (const separator of separators) {
          for (const option of options) {
            for (const filler of ["", "x", " -u", " "]) {
              const text = `curl a${(separator + filler).repeat(lines)}${option} tail${option}`;
              expect([id, text, scanner.pattern.matches(text)]).toEqual([id, text, oracle.matches(text)]);
              expect([id, text, scanner.pattern.groups(text)]).toEqual([id, text, oracle.groups(text)]);
            }
          }
        }
      }
    }
  });

  test("every scanned rule matches as re2js does (seeded fuzz: matches, groups, test)", () => {
    for (const id of SCANNERS.keys()) {
      // re2js's capturing search takes about 1 ms a text here (the matchers about 0.03 ms): 300 a rule in the suite.
      const result = fuzzRule(id, 300, 11);
      expect(result.mismatches).toEqual([]);
      expect(result.positives).toBeGreaterThan(15);
    }
  }, 30_000);
});

describe("the allowlist automaton", () => {
  test("compiles every vendored allowlist regex (a gitleaks update with syntax it lacks fails here)", () => {
    const sources = allowlistRegexes();
    expect(sources.length).toBeGreaterThan(40);
    for (const source of sources) expect(() => compileAllowlistRegex(source)).not.toThrow();
  });

  test("refuses syntax outside its subset instead of guessing", () => {
    for (const source of [
      String.raw`(?m)^a$`,
      String.raw`\pL`,
      "a**",
      String.raw`(a)\1`,
      "[[:punct:]]",
      "(?U)a",
      "(?=a)",
    ]) {
      expect(() => compileAllowlistRegex(source)).toThrow();
    }
  });

  test("refuses what RE2 refuses: a short \\x escape, nested repeats over 1,000 (the review)", () => {
    const sources = [
      String.raw`a\x4`,
      String.raw`a\x4g`,
      String.raw`a\x41`,
      "(a{1,100}){1,100}",
      "(a{1,10}){1,100}",
      "((a{2}){10}){50}",
      "((a{2}){10}){51}",
      "(a{2,}){500}",
      "(a{2,}){501}",
      "(a*){1000}",
      "(a{0}){1000}",
      "a{1001}",
    ];
    const throws = (compile: () => unknown) => {
      try {
        compile();
        return false;
      } catch {
        return true;
      }
    };
    for (const source of sources) {
      const oracle = throws(() => linearEngine(source));
      expect([source, throws(() => compileAllowlistRegex(source))]).toEqual([source, oracle]);
    }
    expect(throws(() => compileAllowlistRegex(String.raw`a\x4`))).toBe(true);
    expect(throws(() => compileAllowlistRegex("(a{1,100}){1,100}"))).toBe(true);
  });

  test("reads classes, escapes and case folding as re2js does, on every code point", () => {
    const sources = [
      ...Object.keys(SCANNER_CLASSES),
      String.raw`\S`,
      String.raw`\W`,
      String.raw`(?i)\W`,
      String.raw`[^:]`,
      String.raw`(?i)[^a-z]`,
      "[[:alnum:]]",
      "(?i)[[:upper:]]",
      String.raw`[\w .-/]`,
      String.raw`(?s:.)`,
      String.raw`[\s\S]`,
      String.raw`\x{2028}`,
      "(?i)k",
      "(?i)S",
    ];
    for (const source of sources) {
      const oracle = linearEngine(`^${source}$`);
      const own = compileAllowlistRegex(`^${source}$`);
      const wrong = CODE_POINTS.filter(
        (cp) => oracle.test(String.fromCodePoint(cp)) !== own.test(String.fromCodePoint(cp)),
      );
      expect([source, wrong.slice(0, 5)]).toEqual([source, []]);
    }
  });

  test("answers as re2js does on every allowlist regex (seeded fuzz)", () => {
    for (const [i, source] of allowlistRegexes().entries()) {
      const result = fuzzAllowlist(source, 300, 100 + i);
      expect(result.mismatches).toEqual([]);
    }
  }, 30_000);

  test("answers as re2js does on assertions, anchors and code points", () => {
    const cases: [string, string[]][] = [
      [String.raw`\bdata:`, ["data:", "xdata:", " data:", "_data:", "\u212adata:", "é data:"]],
      [String.raw`a\B`, ["a", "ab", "a b", "a_"]],
      ["^a|b$", ["a", "xa", "b", "bx", ""]],
      ["a.{2}b", ["a😀😀b", "a\ud800\ud800b", "a😀b", "a😀\ud800b", "axyb", "a\nyb"]],
      ["^$", ["", "a"]],
      [String.raw`\A\z`, ["", "x"]],
      ["x*", ["", "y"]],
      [String.raw`^\{\d{0,2}}$`, ["{}", "{1}", "{12}", "{123}", "{a}"]],
    ];
    for (const [source, texts] of cases) {
      const oracle = linearEngine(source);
      const own = compileAllowlistRegex(source);
      for (const text of texts) expect([source, text, own.test(text)]).toEqual([source, text, oracle.test(text)]);
    }
  });
});

describe("the gate", () => {
  test("finds and redacts exactly what D24's gate did", () => {
    const own = gateOf(rulesWith(GATE_ENGINES));
    const d24 = gateOf(rulesWith(D24_ENGINES));
    const rnd = prng(23);
    const texts: string[] = [];
    for (const id of SCANNERS.keys()) for (let i = 0; i < 150; i++) texts.push(ruleText(rnd, id));
    // Findings that reach allowlists: placeholders, paths, EXAMPLE keys, template values, curl's excused passwords.
    const reaching = [
      `aws_access_key_id = ${"AK" + "IA"}IOSFODNN7EXAMPLE`,
      "password = ${DB_PASSWORD}",
      "api_key: {{ .Values.apiKey }}",
      `curl -u admin:changeme https://x`,
      `curl -u "$USER:$PASS" https://x`,
      "token = /Users/dana/projects/app",
      `export GITHUB_TOKEN="${"gh" + "p_"}${"x".repeat(36)}"`,
      "secret: true",
      `client_secret = "${"ab".repeat(12)}"`,
    ];
    for (const text of [...texts, ...reaching]) {
      expect([text, own.secretHits(text)]).toEqual([text, d24.secretHits(text)]);
      expect([text, own.sanitizeForStore(text)]).toEqual([text, d24.sanitizeForStore(text)]);
    }
  }, 30_000);

  test("loads no re2js in production: only the tests' oracle imports it, and nothing is a dependency", () => {
    for (const file of ["index.ts", "secrets.ts", "scanners.ts", "automaton.ts", "redact.ts"]) {
      expect([file, readFileSync(new URL(file, import.meta.url), "utf8").includes('"re2js"')]).toEqual([file, false]);
    }
    expect(readFileSync(new URL("index.ts", import.meta.url), "utf8")).not.toContain("re2-oracle");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dependencies ?? {}).toEqual({}); // no production dependency at all, @eden/primitives included
    expect(manifest.devDependencies.re2js).toBe("2.9.0");
  });
});
