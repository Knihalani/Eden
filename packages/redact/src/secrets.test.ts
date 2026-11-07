/**
 * D13's secret gate (A6 §2.2): the vendored gitleaks rules, the keyword rule, URL userinfo and the
 * entropy-plus-keyword rule. Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goRegex, sanitizeForStore, secretHits, secretRules } from "./secrets";

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
      "eden-aws-secret",
      "eden-cfat",
      "eden-discord-webhook",
      "eden-entropy-keyword",
      "eden-keyword",
      "eden-legacy-keyword",
      "eden-legacy-token",
      "eden-mailgun",
      "eden-new-relic",
      "eden-openai",
      "eden-presigned-url",
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
    [
      "Discord webhook URL (anyone holding it can post)",
      `alerts go to https://${"discord" + ".com/api/webhooks/"}123456789012345678/${alnum(68)} now`,
      "eden-discord-webhook",
    ],
    [
      "Discord webhook URL on a versioned API path, host in capitals",
      `log: POST https://${"Discord" + ".com/api/v10/webhooks/"}123456789012345678/${alnum(68)} 204`,
      "eden-discord-webhook",
    ],
    // D220: gitleaks' New Relic rules need the vendor's name in reach; a bare user key is caught by its prefix.
    [
      "New Relic user key with no vendor name",
      `use ${"NR" + "AK-"}${alnum(27).toUpperCase()} for the query`,
      "eden-new-relic",
    ],
    [
      "S3 presigned URL's signature (D220)",
      `get it at https://b.s3.amazonaws.com/q.pdf?X-Amz-Expires=3600&${"X-Amz-" + "Signature="}${"0a1b2c3d".repeat(8)}`,
      "eden-presigned-url",
    ],
    [
      "GCS signed URL's signature, lower case (D220)",
      `https://storage.googleapis.com/b/o?x-goog-expires=900&${"x-goog-" + "signature="}${"9f8e7d6c".repeat(64)}`,
      "eden-presigned-url",
    ],
    [
      "a presigned URL in JSON from a Go server, & escaped as \\u0026 (D220)",
      `{"url":"https://b.s3.amazonaws.com/q?X-Amz-Expires=60\\u0026${"X-Amz-" + "Signature="}${"0a1b2c3d".repeat(8)}"}`,
      "eden-presigned-url",
    ],
    [
      "a presigned URL percent-encoded inside another URL's parameter (D220)",
      `https://app.example/r?next=https%3A%2F%2Fb.s3.amazonaws.com%2Fq%3FX-Amz-Expires%3D60%26${"X-Amz-" + "Signature%3D"}${"0a1b2c3d".repeat(8)}%26x%3D1`,
      "eden-presigned-url",
    ],
    [
      "an STS session token in a presigned URL (D220)",
      `?X-Amz-Date=20261107T000000Z&${"X-Amz-" + "Security-Token="}${alnum(40)}%2F${alnum(60, 5)}&X-Amz-Expires=60`,
      "eden-presigned-url",
    ],
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
  // D220: the shapes stay narrow. A New Relic key needs all 27 characters after its prefix; a presigned URL's other
  // parameters and a page that only names the parameter are not secret.
  `the ${"NR" + "AK-"}${"ABC123"} prefix marks a New Relic user key`,
  "https://b.s3.amazonaws.com/q.pdf?X-Amz-Expires=3600&X-Amz-Date=20261107T000000Z&X-Amz-SignedHeaders=host",
  "the X-Amz-Signature query parameter carries the request's signature",
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
    // The redaction memory had before P0.4 stays (review round 1): a passphrase, and a password under 6 characters.
    ["a passphrase", "the gpg passphrase is Tr0ub4dor-and-3.", "Tr0ub4dor-and-3", "the gpg passphrase is [REDACTED]."],
    ["a short password", "The staging root password is toor.", "toor", "root password is [REDACTED]."],
    ["a short prefixed token", `use ${"gh" + "p_"}Ab12 for now`, `${"gh" + "p_"}Ab12`, "use [REDACTED] for now"],
    ["a cfat_ token", `the token ${"cf" + "at_"}${alnum(40)} expired`, `${"cf" + "at_"}${alnum(40)}`, "expired"],
    [
      "entropy with a keyword",
      `deploy secret ${alnum(40, 5)}3 rotates monthly`,
      `${alnum(40, 5)}3`,
      "deploy secret [REDACTED] rotates monthly",
    ],
    [
      "a bare New Relic key (D220)",
      `NR key ${"NR" + "AK-"}${alnum(27).toUpperCase()} rotates monthly`,
      `${"NR" + "AK-"}${alnum(27).toUpperCase()}`,
      "NR key [REDACTED] rotates monthly",
    ],
    [
      "a presigned URL keeps everything but its signature (D220)",
      `https://b.s3.amazonaws.com/q.pdf?X-Amz-Expires=3600&${"X-Amz-" + "Signature="}${"0a1b2c3d".repeat(8)}&x=1`,
      "0a1b2c3d".repeat(8),
      "https://b.s3.amazonaws.com/q.pdf?X-Amz-Expires=3600&X-Amz-Signature=[REDACTED]&x=1",
    ],
    [
      "a JSON-escaped presigned URL keeps the next parameter (D220)",
      `"https://b/q?a=1\\u0026${"X-Amz-" + "Signature="}${"0a1b2c3d".repeat(8)}\\u0026x=1"`,
      "0a1b2c3d".repeat(8),
      "Signature=[REDACTED]\\u0026x=1",
    ],
    [
      "a percent-encoded presigned URL keeps the next parameter (D220)",
      `next=https%3A%2F%2Fb%2Fq%3Fa%3D1%26${"X-Amz-" + "Signature%3D"}${"0a1b2c3d".repeat(8)}%26x%3D1`,
      "0a1b2c3d".repeat(8),
      "Signature%3D[REDACTED]%26x%3D1",
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
