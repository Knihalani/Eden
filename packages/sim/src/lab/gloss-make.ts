/**
 * F1 (docs/research/f1-intent-bridge.md): the request glossary's words, written and glossed into English by Haiku
 * (lab only; Anthropic direct, D97, through the spend ledger). No outside word list: for each language, one call per
 * everyday topic (`TOPICS`) asks for the words a native speaker uses writing to an assistant about it, inflected forms
 * included, each with up to three English base words, and one call asks for the language's function words. The
 * glossary is therefore the model's own output, with no third-party licence on it.
 *
 * Output: one JSON line per word, `{w, g}` (`fn: true` for a function word), in `--out DIR/<lang>.jsonl`; resumable
 * (`DIR/<lang>.done` lists the topics already written).
 *
 *   bun packages/sim/src/lab/gloss-make.ts --langs es,fr --out DIR --spend-ledger F --spend-cap USD [--dry]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicBody, anthropicCost, anthropicPrice } from "@eden/llm";
import { anthropicThinkingOff, keyFor } from "./free";
import { SpendLedger } from "./spend";

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(`--${k}`);
  if (i >= 0) return argv[i + 1]!;
  if (d === undefined) throw new Error(`--${k} is required`);
  return d;
};
const MODEL = "claude-haiku-5-5";
const OUT = opt("out");
const MAX_TOKENS = 12_000;
const CONCURRENCY = Number(opt("concurrency", "8"));
export const NAMES: Record<string, string> = {
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese (European and Brazilian)",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian (Bokmål)",
  ro: "Romanian",
  tr: "Turkish",
  ca: "Catalan",
  fi: "Finnish",
  hu: "Hungarian",
  cs: "Czech",
  id: "Indonesian",
  ms: "Malay",
  tl: "Tagalog",
  sw: "Swahili",
  vi: "Vietnamese",
  ru: "Russian",
  el: "Greek",
  ar: "Arabic",
  ko: "Korean",
  hi: "Hindi written in Latin letters (Hinglish, as typed on a phone)",
};
const LANGS = opt("langs", Object.keys(NAMES).join(",")).split(",");
/** Everyday matters a personal assistant's user writes about, fixed before any screen (life areas, not suites). */
export const TOPICS = [
  "banks, payments, transfers and direct debits",
  "bills, utilities, phone and broadband",
  "taxes, government offices and forms",
  "insurance policies and claims",
  "shopping, orders, refunds and returns",
  "work meetings, calendars and scheduling",
  "email, messages, replies and calls",
  "software, IT, accounts, passwords and devices",
  "employment, leave, payroll and expenses",
  "flights, airports and luggage",
  "trains, buses, taxis, driving and car hire",
  "hotels and holiday lets",
  "restaurants, food, cooking and diets",
  "children, parenting and childcare",
  "school, homework and teachers",
  "doctors, dentists, pharmacies, prescriptions and illness",
  "sport, fitness and gyms",
  "home repairs, plumbers, electricians and builders",
  "renting, landlords, neighbours and buildings",
  "moving house and furniture",
  "cars, servicing, fuel and parking",
  "pets and vets",
  "parties, weddings, birthdays and gifts",
  "friends, dates and social plans",
  "days, months, times of day and dates",
  "numbers, amounts, prices and money words",
  "passports, visas, licences and documents",
  "subscriptions and memberships",
  "deliveries, parcels and post",
  "clothes and personal care",
  "holidays, leisure, tickets and events",
  "contracts, lawyers and legal matters",
  "customers, clients, sales and suppliers",
  "savings, investments, pensions and loans",
  "elderly relatives and care",
  "requests to an assistant: book, cancel, move, pay, send, check, remind, buy, sign, renew, order",
  "projects, reports, deadlines and approvals",
  "health insurance, hospitals and appointments",
];
const FUNCTION = "function words";
mkdirSync(OUT, { recursive: true });

const topicPrompt = (lang: string, topic: string) =>
  `List the ${NAMES[lang]} words a native speaker uses when writing to a personal assistant about ${topic}: up to ` +
  "250 words, nouns (singular and plural), verbs (infinitive and the common conjugated forms, past participle) and " +
  "adjectives, as typed (lowercase, with the language's own letters and accents). For each give its most common " +
  "English meanings as one to three lowercase English content words separated by spaces (base forms), most likely " +
  "first. No names of people, places or brands. Reply with one JSON object mapping each word to its English, and " +
  "nothing else.";
const fnPrompt = (lang: string) =>
  `List the 200 most common ${NAMES[lang]} function words as typed in everyday messages: articles, pronouns and ` +
  "their forms, prepositions and their contractions, conjunctions, auxiliary and modal verbs with their common " +
  "forms, negations, question words and common adverbs (lowercase, with the language's own letters and accents). " +
  "Reply with one JSON array of strings, and nothing else.";

const jobs: { lang: string; topic: string }[] = [];
for (const lang of LANGS) {
  if (!NAMES[lang]) throw new Error(`unknown language ${lang}`);
  const doneFile = join(OUT, `${lang}.done`);
  const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, "utf8").split("\n").filter(Boolean) : []);
  for (const topic of [FUNCTION, ...TOPICS]) if (!done.has(topic)) jobs.push({ lang, topic });
}
const price = anthropicPrice(MODEL);
const bodyOf = (j: (typeof jobs)[number]) =>
  anthropicThinkingOff(
    MODEL,
    anthropicBody(
      { apiKey: "", model: MODEL },
      {
        messages: [{ role: "user", content: j.topic === FUNCTION ? fnPrompt(j.lang) : topicPrompt(j.lang, j.topic) }],
        maxTokens: MAX_TOKENS,
        json: true,
      },
      false,
    ),
  ) as Record<string, unknown>;
const worst = jobs.reduce(
  (n, j) => n + ((JSON.stringify(bodyOf(j)).length / 3) * price.input + MAX_TOKENS * price.output) / 1e6,
  0,
);
console.log(`gloss: ${jobs.length} calls over ${LANGS.length} languages, worst $${worst.toFixed(3)}`);
if (argv.includes("--dry")) process.exit(0);

const ledger = new SpendLedger(opt("spend-ledger"), Number(opt("spend-cap")), opt("run-label", "f1-gloss"), 0.1);
ledger.meter("f1.gloss").reserve(worst);
const headers = { "x-api-key": keyFor(MODEL), "anthropic-version": "2023-06-01", "content-type": "application/json" };
let usd = 0;
let failed = 0;
const lines = (j: (typeof jobs)[number], text: string): string[] | null => {
  const json = text.slice(Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0)));
  try {
    const v = JSON.parse(json.slice(0, Math.max(json.lastIndexOf("}"), json.lastIndexOf("]")) + 1)) as unknown;
    if (j.topic === FUNCTION) {
      if (!Array.isArray(v)) return null;
      return v
        .filter((w): w is string => typeof w === "string")
        .map((w) => JSON.stringify({ w: w.toLowerCase(), g: "", fn: true }));
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return Object.entries(v as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === "string")
      .map(([w, g]) => JSON.stringify({ w: w.toLowerCase().trim(), g: g.toLowerCase().trim().slice(0, 60) }));
  } catch {
    return null;
  }
};
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(bodyOf(j)),
        });
        if (!res.ok) {
          // A billing refusal is not transient: stop rather than book failed calls as data.
          if (res.status === 400 && (await res.text()).includes("credit balance")) throw new Error("no credit");
          await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
          continue;
        }
        const m = (await res.json()) as { content: { type: string; text?: string }[]; usage: Record<string, number> };
        const u = m.usage;
        const usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
        };
        const costUsd = anthropicCost(usage, price);
        usd += costUsd;
        ledger.write("f1.gloss", { model: MODEL, usage, costUsd, latencyMs: 0, ttftMs: null, stopReason: "end" });
        const got = lines(j, m.content.find((c) => c.type === "text")?.text ?? "");
        if (!got) continue;
        if (got.length) appendFileSync(join(OUT, `${j.lang}.jsonl`), got.join("\n") + "\n");
        appendFileSync(join(OUT, `${j.lang}.done`), `${j.topic}\n`);
        ok = true;
      }
      if (!ok) failed++;
    }
  }),
);
console.log(`gloss: $${usd.toFixed(4)}, ${failed} calls failed`);
