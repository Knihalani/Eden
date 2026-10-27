/**
 * Secret-shaped strings for the scanner benchmark and cross-check, assembled from parts and a fixed-seed PRNG so
 * no literal in this repository is a secret (or even a secret's prefix next to a value).
 */
import { emailText, prng, SIZES } from "./gen";

const rand = prng(7);
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const UPPER32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const draw = (alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");

/** Prefixes split in two so the source never holds them whole. */
const p = (a: string, b: string) => a + b;

/** One secret-shaped value per provider, keyed by the gitleaks rule it is shaped for. */
export const SHAPES: Record<string, string> = {
  "github-pat": p("gh", "p_") + draw(ALNUM, 36),
  "aws-access-token": p("AK", "IA") + draw(UPPER32, 16),
  "slack-bot-token": `${p("xo", "xb")}-${draw(DIGITS, 12)}-${draw(DIGITS, 12)}-${draw(ALNUM, 24)}`,
  "stripe-access-token": p("sk_", "live_") + draw(ALNUM, 32),
  "gitlab-pat": p("glp", "at-") + draw(ALNUM, 20),
  "npm-access-token": p("np", "m_") + draw(LOWER + DIGITS, 36),
  "gcp-api-key": p("AI", "za") + draw(ALNUM, 35),
  "shopify-access-token": p("shp", "at_") + draw(HEX, 32),
  "digitalocean-pat": p("dop_", "v1_") + draw(HEX, 64),
  "huggingface-access-token": p("h", "f_") + draw(LOWER, 34),
  "sendgrid-api-token": p("S", "G.") + draw(ALNUM, 22) + "." + draw(ALNUM, 43),
  "anthropic-api-key": p("sk-ant-", "api03-") + draw(ALNUM, 93) + "AA",
  jwt: `${p("e", "yJ")}${draw(ALNUM, 30)}.${p("e", "yJ")}${draw(ALNUM, 40)}.${draw(ALNUM, 43)}`,
  "private-key": [
    `-----${p("BEGIN RSA PRI", "VATE KEY")}-----`,
    draw(ALNUM, 64),
    draw(ALNUM, 64),
    `-----${p("END RSA PRI", "VATE KEY")}-----`,
  ].join("\n"),
  "generic-api-key": `${p("api", "_key")} = "${draw(ALNUM, 32)}"`,
};

/** `text` with `secrets` spliced in at evenly spaced sentence breaks. */
function splice(text: string, secrets: string[]): string {
  const parts = text.split(". ");
  const step = Math.max(1, Math.floor(parts.length / (secrets.length + 1)));
  secrets.forEach((secret, i) => {
    const at = Math.min(parts.length - 1, step * (i + 1));
    parts[at] = `${parts[at]} here it is ${secret} `;
  });
  return parts.join(". ");
}

/** The benchmark's secret text: about 2 KB of email with three secrets from different providers. */
export const THREE_SECRETS = splice(emailText(2048 - 160), [
  SHAPES["github-pat"]!,
  SHAPES["aws-access-token"]!,
  SHAPES["slack-bot-token"]!,
]);

/** The cross-check corpus: benign text at every size and script, the three-secret text, one text per shape. */
export function secretCorpus(): { name: string; text: string }[] {
  const corpus: { name: string; text: string }[] = [];
  for (const size of SIZES) {
    corpus.push({ name: `benign-ascii-${size}`, text: emailText(size) });
    corpus.push({ name: `benign-nonascii-${size}`, text: emailText(size, true) });
  }
  corpus.push({ name: "three-secrets-2k", text: THREE_SECRETS });
  for (const [rule, secret] of Object.entries(SHAPES)) {
    corpus.push({ name: `shape:${rule}`, text: splice(emailText(600, false, 11), [secret]) });
  }
  corpus.push({ name: "all-shapes", text: splice(emailText(4096, true, 13), Object.values(SHAPES)) });
  return corpus;
}
