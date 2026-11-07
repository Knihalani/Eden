#!/usr/bin/env bun
/**
 * RealUse-1 part D, T6: a ReDoS probe and a secret-shape probe over the secret gate, no model.
 *
 * - ReDoS: crafted 1 MB inputs (shapes that make backtracking regexes, prefilters and keyword windows work hardest)
 *   through `sanitizeForStore`, `redactString` and `redact` on a JSON object; best of `--reps` runs, wall ms.
 * - Secret shapes: real-looking secrets in a sentence, each assembled at run time from parts and a seeded generator
 *   so no literal in the repo is secret-shaped (packages/redact/CLAUDE.md). Redacted means the value no longer occurs
 *   in `sanitizeForStore`'s output.
 *
 *   bun packages/sim/lab/realuse-1/D/probes/privacy-probe.ts [--reps 3] [--json out.json]
 */
import { redact, redactString, sanitizeForStore, warmGate } from "@eden/redact";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const reps = Number(opt("--reps", "3"));

// A seeded generator (mulberry32), so every run builds the same values.
let state = 7;
const rnd = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const from = (alphabet: string, n: number) =>
  Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
const an = (n: number) => from(ALNUM, n);
const hex = (n: number) => from("0123456789abcdef", n);
const HEX_UP = "0123456789ABCDEF";
const upnum = (n: number) => from("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", n);
const b64 = (n: number) => from(ALNUM + "+/", n);
const digits = (n: number) => from("0123456789", n);
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const j = (...parts: string[]) => parts.join("");

/** [name, the secret value, the sentence carrying it]. Prefixes are split so no repo literal is a whole token. */
const SECRETS: [string, string, (v: string) => string][] = [];
const add = (name: string, value: string, wrap: (v: string) => string = (v) => `here it is: ${v} thanks`) =>
  SECRETS.push([name, value, wrap]);

add("aws-access-key-id", j("AK", "IA", upnum(16)));
add("aws-secret-key", j(b64(18), "Ab9", b64(19)), (v) => `aws_secret_access_key = ${v}`);
add("github-pat-classic", j("gh", "p_", an(36)));
add("github-oauth", j("gh", "o_", an(36)));
add("github-fine-grained", j("github", "_pat_", an(22), "_", an(59)));
add("gitlab-pat", j("gl", "pat-", an(20)));
add("slack-bot", j("xo", "xb-", digits(12), "-", digits(13), "-", an(24)));
add("slack-user", j("xo", "xp-", digits(12), "-", digits(12), "-", digits(13), "-", hex(32)));
add("slack-webhook", j("https://hooks.sl", "ack.com/services/T", upnum(10), "/B", upnum(10), "/", an(24)));
add("stripe-live-secret", j("sk", "_live_", an(24)));
add("stripe-restricted", j("rk", "_live_", an(24)));
add("openai-project", j("sk", "-proj-", an(48)));
add("anthropic", j("sk", "-ant-api03-", an(93), "AA"));
add("openrouter", j("sk", "-or-v1-", hex(64)));
add("google-api-key", j("AI", "za", an(35)));
add("npm-token", j("np", "m_", an(36)));
add("pypi-token", j("py", "pi-AgEIcHlwaS5vcmc", an(60)));
add("twilio-api-key", j("S", "K", hex(32)));
add("sendgrid", j("S", "G.", an(22), ".", an(43)));
add("mailgun-key", j("ke", "y-", hex(32)));
add("discord-webhook", j("https://discord.com/api/web", "hooks/", digits(18), "/", an(68)));
add("telegram-bot", j(digits(10), ":AA", an(33)));
add("shopify-access", j("shp", "at_", hex(32)));
add("square-access", j("sq0", "atp-", an(22)));
add("digitalocean-pat", j("do", "p_v1_", hex(64)));
add("huggingface", j("h", "f_", from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 34)));
add("linear-api", j("lin", "_api_", an(40)));
add("notion-token", j("nt", "n_", digits(11), an(35)));
add("hashicorp-vault", j("hv", "s.", an(90)));
add("doppler", j("dp", ".pt.", an(43)));
add("atlassian", j("ATA", "TT3", an(186)));
add("jwt", j("ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.", "ey", "J", an(40), ".", an(43)));
add("postgres-url-password", j("postgres://app:", an(20), "@db.internal:5432/prod"), (v) => `DATABASE_URL=${v}`);
add("basic-auth-url", j("https://alice:", an(16), "@example.com/x"), (v) => `fetch ${v}`);
add("bearer-header", j(an(40)), (v) => `Authorization: Bearer ${v}`);
add("password-assign", j(an(6), "!", digits(4)), (v) => `password: ${v}`);
add("azure-storage", j(b64(86), "=="), (v) => `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${v};`);
add("datadog-api-key", hex(32), (v) => `DD_API_KEY=${v}`);
add("heroku-api-key", uuid(), (v) => `HEROKU_API_KEY=${v}`);
add(
  "rsa-private-key",
  j("-----BEGIN RSA PRI", "VATE KEY-----\n", b64(64), "\n", b64(64), "\n-----END RSA PRI", "VATE KEY-----"),
  (v) => `key:\n${v}\n`,
);
add(
  "openssh-private-key",
  j("-----BEGIN OPENSSH PRI", "VATE KEY-----\n", b64(70), "\n-----END OPENSSH PRI", "VATE KEY-----"),
  (v) => `${v}`,
);
add("gcp-service-account", j('"private_key_id": "', hex(40), '"'), (v) => `{"type": "service_account", ${v}}`);
add("cloudflare-api-token", j("cf", "at_", an(40)));
add("age-secret-key", j("AGE-SECRET-KEY-1", from("QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L", 58)));
add("databricks", j("dap", "i", hex(32)));
// Bare (no vendor name near it): gitleaks' rule needs "new-relic" within reach, so this row tests the bare shape.
add("new-relic-bare", j("NR", "AK-", upnum(27)));
add("new-relic-in-context", j("NR", "AK-", upnum(27)), (v) => `NEW_RELIC_API_KEY=${v}`);
add("sentry-user-token", j("sntr", "yu_", hex(64)));
// A DSN's key is public by Sentry's design (it ships in browser code); no gitleaks rule covers it. Counted anyway.
add("sentry-dsn", j("https://", hex(32), "@o", digits(6), ".ingest.sentry.io/", digits(7)), (v) => `SENTRY_DSN=${v}`);
add("generic-api-key-assign", j(an(20), "x9", an(10)), (v) => `api_key = "${v}"`);
// Added for D220 (fix-s6-privacy), after the original 50 so their seeded values do not change.
const s3 = "https://b.s3.amazonaws.com/q.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600";
add("s3-presigned-signature", hex(64), (v) => `download: ${s3}&${j("X-Amz-", "Signature=")}${v}`);
add("s3-presigned-session-token", j(b64(40), "%2F", an(80)), (v) => `${s3}&${j("X-Amz-", "Security-Token=")}${v}&x=1`);
add("gcs-signed-signature", hex(512), (v) => `https://storage.googleapis.com/b/o?${j("X-Goog-", "Signature=")}${v}`);

warmGate?.();
const secretRows = SECRETS.map(([name, value, wrap]) => {
  const text = wrap(value);
  const out = sanitizeForStore(text);
  // The value, or for a multi-line block its longest line, must be gone.
  const probe = value.includes("\n") ? value.split("\n").sort((a, b) => b.length - a.length)[0]! : value;
  return { name, redacted: !out.includes(probe), leftChars: out.includes(probe) ? probe.length : 0 };
});

/** Crafted 1 MB shapes. Each is a function so the strings are built once per shape, not held all at once. */
const MB = 1 << 20;
const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
const SHAPES: Record<string, () => string> = {
  "a-run": () => fill("a"),
  "A-run": () => fill("A"),
  digits: () => fill("0123456789"),
  "hex-run": () => fill("deadbeef"),
  base64ish: () => fill("Ab9+/xYz"),
  spaces: () => fill(" "),
  newlines: () => fill("\n"),
  "akia-repeat": () => fill(j("AK", "IA")),
  "akia-near-miss": () => fill(j("AK", "IA", "ABCDEFGHIJKLMNO ")),
  "pem-open-no-close": () => j("-----BEGIN RSA PRI", "VATE KEY-----\n") + fill("QUJD\n"),
  "pem-headers-repeat": () => fill(j("-----BEGIN PRI", "VATE KEY-----\n")),
  "url-userinfo-chain": () => "https://" + fill("a:b@"),
  "scheme-repeat": () => fill("https://"),
  "at-run": () => fill("@"),
  "password-eq-repeat": () => fill("password="),
  "secret-keyword-tokens": () => fill("secret " + "x".repeat(31) + "1 "),
  "api-key-quote-unclosed": () => 'api_key = "' + fill("a1"),
  "token-colon-chain": () => fill("token: "),
  "gh-prefix-repeat": () => fill(j("gh", "p_")),
  "xox-repeat": () => fill(j("xo", "xb-1-")),
  "jwt-dots": () => fill(j("ey", "J.")),
  "sk-dash-chain": () => fill(j("sk", "-")),
  "equals-run": () => fill("="),
  "quote-run": () => fill('"'),
  "backslash-run": () => fill("\\"),
  "unicode-mix": () => fill("é密码🔑ß"),
  "keyword-near-entropy": () => fill("key " + "Ab1".repeat(11) + " "),
  "aws-secret-near-miss": () => fill(j("AK", "IA") + "A".repeat(16) + " " + "Ab9+".repeat(10) + " "),
  "dash-run": () => fill("-"),
  "mixed-punct": () => fill("a=b;c:d@e/f?g&"),
  // Added for D220's rules (fix-s6-privacy).
  "presigned-param-repeat": () => fill(j("&X-Amz-", "Signature=0123456789abcde")),
  "nrak-near-miss": () => fill(j("NR", "AK-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ ")),
};

const time = (fn: () => void) => {
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return Math.round(best * 10) / 10;
};
const redosRows: { shape: string; sanitizeMs: number; redactStringMs: number; redactObjectMs: number }[] = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  const s = make();
  if (s.length !== MB && !shape.startsWith("pem") && !shape.startsWith("url") && !shape.startsWith("api"))
    throw new Error(`${shape}: ${s.length} chars`);
  redosRows.push({
    shape,
    sanitizeMs: time(() => sanitizeForStore(s)),
    redactStringMs: time(() => redactString(s)),
    redactObjectMs: time(() => redact({ body: s, nested: { note: s.slice(0, 4096) } })),
  });
  console.error(`${shape}: ${JSON.stringify(redosRows.at(-1))}`);
}
const max = (k: "sanitizeMs" | "redactStringMs" | "redactObjectMs") =>
  redosRows.reduce((m, r) => (r[k] > m.ms ? { ms: r[k], shape: r.shape } : m), { ms: 0, shape: "" });

const summary = {
  secrets: {
    formats: secretRows.length,
    redacted: secretRows.filter((r) => r.redacted).length,
    missed: secretRows.filter((r) => !r.redacted).map((r) => r.name),
  },
  redos: {
    shapes: redosRows.length,
    inputChars: MB,
    reps,
    max: { sanitize: max("sanitizeMs"), redactString: max("redactStringMs"), redactObject: max("redactObjectMs") },
  },
};
console.log(JSON.stringify(summary, null, 2));
if (argv.includes("--json"))
  await Bun.write(opt("--json", ""), JSON.stringify({ summary, secretRows, redosRows }, null, 1));
