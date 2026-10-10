/**
 * The `secrets` arm (A5 §4; A6 §2.2): 30 secret shapes, each said through 4 channels (a typed prompt, a marked
 * paste, a tool result, assistant text) at 3 positions (opening a message, inside a sentence, an env-file line):
 * 360 cases, past A5's "≥ 300 cases", so a 0 bounds the leak rate near 1% (X6). Every case has its own value, so
 * a leak names its shape and channel. `secret_bytes` counts their bytes anywhere under the memory root, in the
 * plugin's data directory, or in any packet.
 *
 * The values are synthetic, drawn from a seeded stream when the arm runs: provider prefixes are split in the source,
 * so no secret-shaped literal is ever committed, and nothing here is a real credential. A shape that a scanner can
 * only recognise by its keyword (a password, a Heroku key) always has the keyword before the value, as D13's
 * keyword rule reads it.
 */
import { readFileSync } from "node:fs";
import { countBy } from "../harness/metrics";
import { Rng } from "../harness/rng";
import type { SimWorld } from "../harness/session";
import { DB, id, monorepo, set } from "./fixtures/world";
import { bash, BLANK_SUMMARY, check, Driver, edenFiles, metricsOf, needMet, pasted, type Arm } from "./kit";

type Shape = { name: string; value: (rng: Rng) => string; keyword?: string };

const upper = (rng: Rng, n: number) =>
  rng
    .base62(n * 2)
    .replace(/[a-z0-9]/g, "")
    .padEnd(n, "Q")
    .slice(0, n);
const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.int(0, 9)).join("");
const b64url = (text: string) => Buffer.from(text).toString("base64url");

/** The 30 shapes: provider tokens from the gitleaks default rules, plus D13's keyword and URL-userinfo cases. */
export const SHAPES: Shape[] = [
  { name: "aws-access-key", value: (r) => "AK" + "IA" + upper(r, 16) },
  { name: "aws-secret-key", value: (r) => r.base62(40), keyword: "aws_secret_access_key = " },
  { name: "github-pat", value: (r) => "gh" + "p_" + r.base62(36) },
  { name: "github-oauth", value: (r) => "gh" + "o_" + r.base62(36) },
  { name: "github-fine-grained", value: (r) => "github" + "_pat_" + r.base62(22) + "_" + r.base62(59) },
  { name: "gitlab-pat", value: (r) => "gl" + "pat-" + r.base62(20) },
  { name: "slack-bot", value: (r) => "xo" + "xb-" + digits(r, 11) + "-" + digits(r, 12) + "-" + r.base62(24) },
  {
    name: "slack-webhook",
    value: (r) => "https://hooks.slack.com/" + "services/T" + upper(r, 9) + "/B" + upper(r, 9) + "/" + r.base62(24),
  },
  { name: "stripe-live", value: (r) => "sk" + "_live_" + r.base62(24) },
  { name: "stripe-restricted", value: (r) => "rk" + "_live_" + r.base62(24) },
  { name: "google-api", value: (r) => "AI" + "za" + r.base62(35) },
  { name: "openai", value: (r) => "sk" + "-proj-" + r.base62(48) },
  { name: "anthropic", value: (r) => "sk" + "-ant-api03-" + r.base62(93) + "AA" },
  { name: "npm", value: (r) => "np" + "m_" + r.base62(36) },
  { name: "pypi", value: (r) => "py" + "pi-AgEIcHlwaS5vcmc" + r.base62(50) },
  { name: "twilio", value: (r) => "SK" + r.hex(32) },
  { name: "sendgrid", value: (r) => "SG" + "." + r.base62(22) + "." + r.base62(43) },
  { name: "mailgun", value: (r) => "key" + "-" + r.hex(32) },
  {
    name: "jwt",
    value: (r) =>
      [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(`{"sub":"${r.hex(8)}","role":"admin"}`), r.base62(43)].join("."),
  },
  {
    name: "private-key",
    value: (r) =>
      [
        "-----BEGIN RSA " + "PRIVATE KEY-----",
        r.base62(64),
        r.base62(64),
        r.base62(40),
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
  },
  {
    name: "heroku",
    value: (r) => [r.hex(8), r.hex(4), r.hex(4), r.hex(4), r.hex(12)].join("-"),
    keyword: "heroku api key: ",
  },
  { name: "digitalocean", value: (r) => "do" + "p_v1_" + r.hex(64) },
  { name: "shopify", value: (r) => "sh" + "pat_" + r.hex(32) },
  { name: "square", value: (r) => "sq0" + "atp-" + r.base62(22) },
  { name: "telegram", value: (r) => digits(r, 10) + ":" + "AA" + r.base62(33) },
  { name: "databricks", value: (r) => "dap" + "i" + r.hex(32) },
  { name: "doppler", value: (r) => "dp" + ".pt." + r.base62(43) },
  { name: "cloudflare", value: (r) => "cf" + "at_" + r.base62(40) },
  {
    name: "password",
    value: (r) => `${r.base62(6)}-${r.base62(6)}-${r.base62(4)}`,
    keyword: "the staging password is ",
  },
  { name: "url-userinfo", value: (r) => r.base62(16), keyword: "postgres://admin:" },
];

export const CHANNELS = ["prompt", "paste", "tool", "assistant"] as const;
export const POSITIONS = ["start", "middle", "env-line"] as const;

export interface SecretCase {
  shape: string;
  channel: (typeof CHANNELS)[number];
  position: (typeof POSITIONS)[number];
  secret: string;
  /** The case as it appears in its message. */
  text: string;
}

/** The text a case puts in a message: its value (after its keyword, if any) at its position. */
function place(shape: Shape, secret: string, position: SecretCase["position"]): string {
  const said = (shape.keyword ?? "") + secret + (shape.name === "url-userinfo" ? "@db.internal.invalid:5432/app" : "");
  if (position === "start") return `${said} is what staging uses.`;
  if (position === "middle") return `For staging, use ${said} when you call the API.`;
  return `STAGING_${shape.name.toUpperCase().replaceAll("-", "_")}=${said}`;
}

/** Every case, in a fixed order, with values from the arm's seeded stream. */
export function secretCases(seed = 13): SecretCase[] {
  const rng = new Rng(seed);
  return CHANNELS.flatMap((channel) =>
    POSITIONS.flatMap((position) =>
      SHAPES.map((shape) => {
        const secret = shape.value(rng);
        return { shape: shape.name, channel, position, secret, text: place(shape, secret, position) };
      }),
    ),
  );
}

/** Cases per message. */
const PER_MESSAGE = 6;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export const secrets: Arm = {
  id: "secrets",
  flagged: true,
  async run(run) {
    const cases = secretCases();
    const spec = monorepo({ secrets: cases.map((item) => item.secret) });
    const world = run.world(spec);
    const by = (channel: SecretCase["channel"]) =>
      chunks(
        cases.filter((item) => item.channel === channel),
        PER_MESSAGE,
      ).map((group) => group.map((item) => item.text).join("\n"));
    const [prompts, pastes, tools, replies] = [by("prompt"), by("paste"), by("tool"), by("assistant")];
    const session = await Driver.start(world, spec);
    await session.say("The staging database is postgres.", [set(DB, "", "postgres")]);
    for (const [n, text] of prompts.entries()) {
      await session.turn(`${text}\nwhy does staging reject these?`, {
        tools: [[bash("cat .env.staging", 0, tools[n]!)]],
        reply: `I found these values in the logs:\n${replies[n]!}`,
      });
    }
    for (const [n, text] of pastes.entries()) {
      await session.turn(`here is the env file from the wiki:\n${pasted(text, `s${n}`)}\nwhy does staging fail?`);
    }
    await session.compact(BLANK_SUMMARY);
    const control = await session.ask("what database does staging use?", { needs: [id(DB, "")] });
    await session.ask("what is the staging password?", {});
    await session.ask("which keys did I give you earlier?", {});
    // The session's last reply quotes secrets, so the last Stop's `last_assistant_message` carries them: what a
    // hook keeps of the agent's last message (P0.6's `qprev.json`) is under the memory root too.
    await session.turn("list the values you found in the logs", { reply: `From the logs:\n${replies.at(-1)!}` });
    await session.end();
    const metrics = metricsOf(world, spec);
    const leaked = leakedCases(cases, world);
    const count = (field: "channel" | "shape") =>
      Object.entries(countBy(leaked.map((item) => item[field])))
        .map(([key, n]) => `${key} ${n}`)
        .join(", ");
    return [
      check(
        "control-packs",
        needMet(metrics, control),
        `the staging database ${needMet(metrics, control) ? "packed" : "missed"}`,
      ),
      check(
        "secret-bytes",
        metrics.secret_bytes === 0,
        `secret_bytes ${metrics.secret_bytes}; ${leaked.length} of ${cases.length} cases leaked` +
          (leaked.length ? ` (by channel: ${count("channel")}; by shape: ${count("shape")})` : ""),
      ),
    ];
  },
};

/** The cases whose value is in a packet or in a file Eden wrote. */
function leakedCases(cases: readonly SecretCase[], world: SimWorld): SecretCase[] {
  const packets = world.deliveries.map((delivery) => delivery.content).join("\n");
  const stored = edenFiles(world)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  return cases.filter((item) => packets.includes(item.secret) || stored.includes(item.secret));
}
