/**
 * `eden-aws-secret`: an AWS secret access key (40 characters of base64's alphabet) beside its key id, beside a key id
 * an earlier pass already redacted, or beside the word "secret". Secret-shaped values are assembled from parts, so no
 * literal in this file is one.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeForStore, secretHits } from "./secrets";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+";

/** A deterministic 40-character token drawn from `alphabet` (AWS's: base64 without padding). */
function token(seed: number, alphabet = BASE64): string {
  let x = seed;
  let out = "";
  for (let i = 0; i < 40; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[(x >>> 8) % alphabet.length];
  }
  return out;
}
const KEY_ID = `${"AK" + "IA"}${"IOSFODNN7QWERTYU"}`;
const TEMP_ID = `${"AS" + "IA"}${"Z2E0A8F3B244C998"}`;
/** The shape the sim world writes (letters and digits only, no `/` or `+`). */
const SIM_SECRET = token(3, BASE64.slice(0, 62));
/** A secret holding `/` and `+`, which rule (d) skips. */
const SLASHED = `${"wJalr/K7MD+bPxRfiCY"}${token(8).slice(19)}`;

describe("an AWS secret access key is redacted", () => {
  const positives: [name: string, text: string, secret: string][] = [
    ["beside a redacted key id (the reported leak)", `[REDACTED] / ${SIM_SECRET}`, SIM_SECRET],
    ["beside its key id", `here you go: ${KEY_ID} / ${token(1)}`, token(1)],
    ["beside a temporary key id", `${TEMP_ID} ${token(2)}`, token(2)],
    ["with the key id after it", `${token(4)} goes with ${KEY_ID}`, token(4)],
    ["after the word secret", `the aws secret key, wait, it is ${token(5)}`, token(5)],
    ["in an env line", `AWS_SECRET_ACCESS_KEY=${token(6)}`, token(6)],
    ["in a credentials file", `aws_access_key_id = ${KEY_ID}\naws_secret_access_key = ${token(7)}`, token(7)],
    ["holding / and +", `secret ${SLASHED}`, SLASHED],
    ["in a CSV row", `user,${KEY_ID},${token(9)}`, token(9)],
    ["in YAML", `Credentials:\n  SecretAccessKey: ${token(10)}\n  Expiration: soon`, token(10)],
    ["holding a slash after a redacted id", `[REDACTED]\t/${token(18).slice(1)}`, `/${token(18).slice(1)}`],
  ];
  for (const [name, text, secret] of positives) {
    test(name, () => {
      const stored = sanitizeForStore(text);
      expect(stored).not.toContain(secret);
      expect(stored).toContain("[REDACTED]");
      expect(secretHits(text)).toContain("eden-aws-secret");
      expect(sanitizeForStore(stored)).toBe(stored);
    });
  }

  test("the reported text loses the secret and keeps its words", () => {
    expect(sanitizeForStore(`here you go: ${KEY_ID} / ${SIM_SECRET}\n\nDon't share it`)).toBe(
      "here you go: [REDACTED] / [REDACTED]\n\nDon't share it",
    );
  });
});

describe("what eden-aws-secret leaves alone", () => {
  const negatives: [name: string, text: string][] = [
    ["a git SHA beside a key id (pure hex)", `${KEY_ID} was rotated in 9fceb02d0ae598e95dc970b74767f19372d61af8`],
    ["an upper-case hex digest beside secret", "secret digest 9FCEB02D0AE598E95DC970B74767F19372D61AF8"],
    ["a 40-character token with no anchor", `the build artifact is ${token(11)} today`],
    ["an anchor 60 characters away", `secret ${"x".repeat(60)} ${token(12)}`],
    ["a 39-character token", `secret ${token(13).slice(0, 39)}`],
    ["a 41-character token", `secret ${token(14)}Q`],
    ["a path of 40 characters", "secret file at /Users/Kai/Documents/Projects/Eden/srcab"],
    ["a relative path of 40 characters", "secret in src/Components/Settings/SecretsPanel/abc"],
    ["a CamelCase name with low entropy", "secret SecretsManagerGetSecretValueRequestInput"],
    ["all lower case", `secret ${token(15, "abcdefghijklmnopqrstuvwxyz0123456789")}`],
    ["all upper case", `secret ${token(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`],
    ["Asia in prose", `flights to Asia ${token(17)}`],
    ["prose about secrets", "the secrets manager rotates every key on the first Monday of each month"],
  ];
  for (const [name, text] of negatives) {
    test(name, () => expect(secretHits(text)).not.toContain("eden-aws-secret"));
  }
});
