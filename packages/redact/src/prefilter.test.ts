/**
 * The keyword prefilter (one Aho–Corasick pass) must not change what the gate finds: for every text, each rule's
 * findings equal those of the original filter (a rule runs when one of its keywords is in the lowercased text;
 * keyword-less rules always run). Secret-shaped values are assembled from parts, so no literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeForStore, secretHits, secretRules } from "./secrets";

const alnum = (n: number, seed = 7) =>
  Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN2pQ4sT6vW8yZ"[(i * seed + 3) % 26]).join("");

/** The gate as it was before the prefilter: one `includes` per keyword, keyword-less rules always. */
function referenceHits(text: string): string[] {
  const lower = text.toLowerCase();
  return secretRules()
    .filter((rule) => !rule.keywords.length || rule.keywords.some((word) => lower.includes(word)))
    .filter((rule) => rule.spans(text).length > 0)
    .map((rule) => rule.id)
    .sort();
}

const SECRETS = [
  `${"gh" + "p_"}${alnum(36)}`,
  `${"AK" + "IA"}QWERTYUIOPASDFGH`,
  `${"sk" + "-proj-"}${alnum(48)}`,
  `${"cf" + "at_"}${alnum(40)}`,
  `${"key" + "-"}${"0123456789abcdef".repeat(2)}`,
  `${"1234567890:" + "AA"}${alnum(33)}`,
  `postgres://admin:${alnum(12)}@db.internal:5432/app`,
  "the staging PASSWORD is Tr0ub4dor-x9",
  `deploy secret ${alnum(40, 5)}3 rotates`,
  `${"xox" + "b-"}${"1234567890"}-${"1234567890123"}-${alnum(24)}`,
  `Authorization: Bearer ${alnum(30)}`,
  `"api_key": "${alnum(32, 11)}"`,
  `${"sk_" + "live_"}${alnum(24)}`,
  `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn${alnum(40)}\n-----END RSA PRIVATE KEY-----`,
];
const PROSE = [
  "Hi Dana, following up on the Globex renewal; Bill said Initech pays annually.",
  "Müller’s café booking for Zoë on Thursday at 3pm, ref OPS-142.",
  "the token bucket refills at 10/s and the api docs are at https://example.com/docs",
  "",
];

describe("prefilter equivalence", () => {
  test("every rule finds the same secrets as with the per-keyword filter", () => {
    let x = 11;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const texts: string[] = [...SECRETS, ...PROSE];
    for (let i = 0; i < 300; i++) {
      const parts = Array.from({ length: 1 + rnd(4) }, () =>
        rnd(3) === 0 ? SECRETS[rnd(SECRETS.length)]! : PROSE[rnd(PROSE.length)]!,
      );
      const mixed = parts.join(rnd(2) ? " " : "\n");
      texts.push(rnd(4) === 0 ? mixed.toUpperCase() : mixed);
    }
    for (const text of texts) expect(secretHits(text)).toEqual(referenceHits(text));
  });

  test("the secrets above are all redacted", () => {
    for (const secret of SECRETS) {
      // A bare `Authorization: Bearer …` is no rule hit (secretHits); the structural redactor that sanitizeForStore
      // runs afterwards catches it. Every other sample is a rule hit too.
      if (!secret.startsWith("Authorization")) expect(secretHits(`note: ${secret} end`).length).toBeGreaterThan(0);
      expect(sanitizeForStore(`note: ${secret} end`)).toContain("[REDACTED]");
    }
  });
});
