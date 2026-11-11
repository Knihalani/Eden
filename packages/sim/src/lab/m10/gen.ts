#!/usr/bin/env bun
/**
 * M10 (lab only): generated item families for the card tagger's training split, on Anthropic through the spend
 * ledger (D97). Each call is given one area, constraint kind, action and format, and writes `--per` short fictional
 * items: most state a constraint of that kind, some are look-alikes that state none (lifted, cleared, routine,
 * marketing, small talk about the same thing). Their cards come later from the shipped card call (`label.ts`), as
 * every other training item's do: the generator's own intent is never a label. All are train: the held-out families
 * stay the sim's (train5 and train6 planted, and the hash split).
 *
 *   bun packages/sim/src/lab/m10/gen.ts --out .local/m10/gen-raw.jsonl --calls 150 --spend-ledger F --spend-cap 3
 */
import { appendFileSync } from "node:fs";
import { AnthropicModel } from "@eden/llm";
import { keyFor } from "../free";
import { SpendLedger } from "../spend";
import { Rng } from "../../rng";

const argv = process.argv.slice(2);
const opt = (n: string, d = "") => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d);
const cap = Number(opt("spend-cap"));
if (!opt("spend-ledger") || !Number.isFinite(cap) || cap <= 0) throw new Error("--spend-ledger and --spend-cap");
const out = opt("out");
const calls = Number(opt("calls", "100"));
const per = Number(opt("per", "16"));

const AREAS = ["work engineering", "work sales", "work finance", "work HR", "family", "health", "money", "travel",
  "home", "admin and government", "social", "school", "legal", "procurement", "events", "property"];
const KINDS = [
  "freeze (a hold, closure, outage or blackout over a period)",
  "deadline (something due or expiring by a date)",
  "limit (an amount cap or threshold, in money or percent)",
  "absence (a person away or unavailable over days)",
  "prohibition (something must not be done)",
  "dependency (an approval or sign-off needed first that has not happened)",
  "status-change (a date, time, price, bank details, address, plan or contact person changed)",
  "preference (a diet, allergy, access need, or a standing rule like no gifts or no calls after 6pm)",
  "already-done (the action was already done or happens automatically)",
];
const ACTS = ["deploy or migrate systems", "delete data", "pay or transfer money", "share or forward documents",
  "buy, order or renew", "travel", "book food or a restaurant", "book a venue or tickets", "hire or make an offer",
  "schedule or move a meeting", "contact someone", "send a gift or parcel", "attend in person", "sign a contract"];
const FORMATS = [
  "one short line of a dozen words or fewer, like a sticky note or a text message",
  "a chat channel excerpt: lines like '[09:14] Name Surname: message', two to six lines",
  "an email with a 'Date: Mon, 26 Oct 2026 09:00' line, a greeting, two to five sentences and a sign-off",
  "a calendar event: a title, a 'When:' line and a short description",
  "an automated notification from a service, with a reference number",
  "a document excerpt or policy paragraph",
  "a forwarded email whose own note is one line above the forwarded text",
  "a long email of eight to twelve sentences where the constraint is one sentence in the middle",
];
const DATES = ["'4-9 Nov'", "'Nov 4'", "'04/11/2026'", "'next Tuesday'", "'the 12th'", "'end of the month'",
  "'4 November 2026'", "'Thursday'", "'until January'", "'from 1 Dec'", "'within 7 days'", "'2026-11-04'"];

const ledger = new SpendLedger(opt("spend-ledger"), cap, opt("run-label", "m10-gen"), 0.1);
const model = opt("model", "claude-haiku-5-5");
const chat = new AnthropicModel({ apiKey: keyFor(model), model, meter: ledger.meter("m10.gen"), timeoutMs: 300_000 });
const rng = new Rng(Number(opt("seed", "7")));
const pick = <T>(xs: T[]) => xs[Math.floor(rng.next() * xs.length)]!;

const one = async (k: number) => {
  const area = pick(AREAS);
  const kind = pick(KINDS);
  const act = pick(ACTS);
  const format = pick(FORMATS);
  const date = pick(DATES);
  const dated = `2026-${pick(["09", "10", "10", "11", "11", "12"])}-${String(1 + Math.floor(rng.next() * 28)).padStart(2, "0")}`;
  const sys =
    "You write realistic but entirely fictional items from one person's mail, chat, calendar, documents and " +
    "notifications, as training data for a classifier. Invent names, companies, places, amounts and references; " +
    "vary them widely (many cultures and countries, currencies £ $ €, percentages). Never copy real people or brands.";
  const user =
    `Write ${per} different items for the area "${area}". Each is ${format}. Items are dated ${dated}.\n` +
    `- ${Math.round(per * 0.6)} of them state a constraint of kind ${kind} that bears on the action "${act}"; ` +
    `vary what is constrained, who and which dates or amounts (write dates in forms like ${date} and others).\n` +
    `- The other ${per - Math.round(per * 0.6)} are look-alikes about the same subjects that state NO constraint: ` +
    "a hold that was lifted or cleared, an approval already given, a routine confirmation, a newsletter, small talk, " +
    "a question, or a constraint about something else entirely that was resolved.\n" +
    'Reply with JSON only: {"items":[{"title":"...","text":"...","source":"mail|chat|calendar|docs|notification"}]}';
  const res = await chat.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    maxTokens: 8_000,
    json: true,
  });
  let v: { items?: { title?: unknown; text?: unknown; source?: unknown }[] };
  try {
    v = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
  } catch {
    return 0;
  }
  const lines = (v.items ?? [])
    .filter((x) => typeof x.title === "string" && typeof x.text === "string")
    .map((x) =>
      JSON.stringify({
        title: String(x.title).slice(0, 200),
        text: String(x.text).slice(0, 2_400),
        source: typeof x.source === "string" ? x.source.slice(0, 20) : "mail",
        dated,
        family: `gen-${opt("seed", "7")}-${k}`,
      }),
    );
  if (lines.length) appendFileSync(out, lines.join("\n") + "\n");
  return lines.length;
};
let made = 0;
let failed = 0;
const todo = Array.from({ length: calls }, (_, i) => i);
await Promise.all(
  Array.from({ length: Number(opt("concurrency", "8")) }, async () => {
    for (let k = todo.shift(); k !== undefined; k = todo.shift())
      made += await one(k).catch((e) => {
        failed++;
        console.log(`m10 gen: a call failed: ${String(e).slice(0, 160)}`);
        return 0;
      });
  }),
);
console.log(`m10 gen: ${made} items from ${calls} calls, ${failed} failed; ledger USD ${ledger.committedUsd.toFixed(4)}`);
