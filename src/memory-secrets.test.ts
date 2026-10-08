/**
 * D13's secret gate (A6 §2.2): the vendored gitleaks rules, the keyword rule, URL userinfo and the
 * entropy-plus-keyword rule. Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goRegex, sanitizeForStore, secretHits, secretRules } from "./memory-secrets";

const VENDORED = join(import.meta.dir, "vendor", "gitleaks", "gitleaks.toml");
const alnum = (n: number, seed = 7) =>
  Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN2pQ4sT6vW8yZ"[(i * seed + 3) % 26]).join("");

describe("the vendored gitleaks rules", () => {
  test("are gitleaks v8.30.1's default config, byte for byte", () => {
    const sha = createHash("sha256").update(readFileSync(VENDORED)).digest("hex");
    expect(sha).toBe("e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf");
  });

  test("every rule with a regex compiles in JavaScript, beside Eden's own rules", () => {
    const ids = secretRules().map((rule) => rule.id);
    expect(ids.filter((id) => !id.startsWith("eden-")).length).toBe(221);
    expect(ids.filter((id) => id.startsWith("eden-")).sort()).toEqual([
      "eden-aws-key-id",
      "eden-cfat",
      "eden-entropy-keyword",
      "eden-keyword",
      "eden-mailgun",
      "eden-openai",
      "eden-telegram",
      "eden-url-userinfo",
    ]);
  });
});

describe("Go regular expressions in JavaScript", () => {
  test("a leading (?i) becomes the i flag", () => {
    const regex = goRegex("(?i)abc");
    expect(regex.flags).toContain("i");
    expect(regex.test("xABCx")).toBe(true);
  });

  test("an inner (?i) holds to the end of its group, in every later alternative", () => {
    const regex = goRegex("^(?:x(?:y(?i)z|w)q)$");
    expect(regex.test("xyZq")).toBe(true);
    expect(regex.test("xWq")).toBe(true);
    expect(regex.test("xYzq")).toBe(false);
    expect(regex.test("xyzQ")).toBe(false);
    const top = goRegex("^a(?i)b|c$");
    expect(top.test("aB")).toBe(true);
    expect(top.test("C")).toBe(true);
    expect(top.test("Ab")).toBe(false);
  });

  test("POSIX classes, \\z, \\A and named groups translate", () => {
    expect(goRegex("^p[[:alnum:]]{2}\\z").test("pa1")).toBe(true);
    expect(goRegex("^p[[:alnum:]]{2}\\z").test("p_1")).toBe(false);
    expect(goRegex("\\Ahead").test("a head")).toBe(false);
    expect(goRegex("(?P<word>[a-z]+)").exec("42 ok")?.groups?.word).toBe("ok");
    expect(goRegex("a\\\\z").test("a\\z")).toBe(true);
  });

  test("a class opening with a literal ] keeps it literal", () => {
    expect(goRegex("^[^]]+$").test("abc")).toBe(true);
    expect(goRegex("^[^]]+$").test("a]")).toBe(false);
    expect(goRegex("^[]a]+$").test("]a")).toBe(true);
  });

  test("a POSIX class the rules do not use is refused, not guessed", () => {
    expect(() => goRegex("[[:digit:]]")).toThrow("digit");
  });
});

describe("what hits", () => {
  const cases: [string, string, string][] = [
    ["gitleaks provider token", `ci uses ${"gh" + "p_"}${alnum(36)} for releases`, "github-pat"],
    ["gitleaks AWS key", `key ${"AK" + "IA"}${"QWERTYUIOPASDFGH"} in the config`, "aws-access-token"],
    ["D13 keyword rule", "the staging password is Tr0ub4dor-x9", "eden-keyword"],
    ["URL userinfo", `connect with postgres://admin:${alnum(12)}@db.internal:5432/app`, "eden-url-userinfo"],
    ["cfat_ (R9 R5.2)", `the token ${"cf" + "at_"}${alnum(40)} expired`, "eden-cfat"],
    ["OpenAI project key without its marker", `use ${"sk" + "-proj-"}${alnum(48)} here`, "eden-openai"],
    ["Mailgun key without the word mailgun", `${"key" + "-"}${"0123456789abcdef".repeat(2)} works`, "eden-mailgun"],
    ["Telegram bot token without the word", `bot ${"1234567890:" + "AA"}${alnum(33)} is live`, "eden-telegram"],
    ["AWS key id below the entropy floor", `id ${"AK" + "IA"}${"Q".repeat(16)} is set`, "eden-aws-key-id"],
    ["entropy + keyword", `deploy secret ${alnum(40, 5)}3 rotates monthly`, "eden-entropy-keyword"],
  ];
  for (const [name, text, rule] of cases) {
    test(name, () => expect(secretHits(text)).toContain(rule));
  }
});

const BENIGN = [
  "fix the failing test in apps/web/src/auth.ts",
  "the auth provider is Clerk and the database is postgres",
  "what does the token bucket algorithm do?",
  "why does the api key rotation job fail on Mondays?",
  "use pnpm, not npm",
  "the build id is 01J9ZQ4S8R6X2M3N5P7Q9T1V3W",
  "request 3f1c2a9e-7b4d-4e8a-9c21-5d6e7f8a9b0c failed",
  "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 broke it",
  "integrity sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUR1ZsZW9I6Xa7yuqd==",
  "read /Users/someone/Downloads/project/packages/cli/src/index.ts",
  "set the session timeout to 30 minutes",
  // D13's keyword rule reads "is" as a word: "secrets" … "this" is no assignment (the P0.0d follow-up).
  "keep the secrets in this pre-registration file",
];

describe("what does not hit", () => {
  for (const text of BENIGN) {
    test(text, () => expect(secretHits(text)).toEqual([]));
  }
});

describe("sanitizeForStore (D13, A6 §2.2): the value goes, what it is stays", () => {
  const key = `${"gh" + "p_"}${alnum(36)}`;
  const cases: [name: string, text: string, secret: string, kept: string][] = [
    ["a provider token mid-sentence", `ci uses ${key} for releases`, key, "ci uses [REDACTED] for releases"],
    ["an env line", `GITHUB_TOKEN=${key}`, key, "GITHUB_TOKEN="],
    [
      "D13's keyword rule",
      "the staging password is Tr0ub4dor-x9",
      "Tr0ub4dor-x9",
      "the staging password is [REDACTED]",
    ],
    [
      "URL userinfo keeps the host",
      `connect with postgres://admin:${alnum(12)}@db.internal:5432/app`,
      alnum(12),
      "@db.internal:5432/app",
    ],
    ["a cfat_ token", `the token ${"cf" + "at_"}${alnum(40)} expired`, `${"cf" + "at_"}${alnum(40)}`, "expired"],
    [
      "entropy with a keyword",
      `deploy secret ${alnum(40, 5)}3 rotates monthly`,
      `${alnum(40, 5)}3`,
      "deploy secret [REDACTED] rotates monthly",
    ],
    [
      "a private key block, whole",
      ["-----BEGIN RSA " + "PRIVATE KEY-----", alnum(64), alnum(64, 5), "-----END RSA PRIVATE KEY-----"].join("\n"),
      alnum(64, 5),
      "[REDACTED]",
    ],
  ];
  for (const [name, text, secret, kept] of cases) {
    test(name, () => {
      const stored = sanitizeForStore(text);
      expect(stored).not.toContain(secret);
      expect(stored).toContain(kept);
      expect(secretHits(stored)).toEqual([]);
      expect(sanitizeForStore(stored)).toBe(stored);
    });
  }

  test("text with no secret is stored as it is", () => {
    for (const text of BENIGN) expect(sanitizeForStore(text)).toBe(text);
  });
});
