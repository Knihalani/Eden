/**
 * F1 (docs/research/f1-intent-bridge.md): the request glossary's word lists, glossed into English once by Haiku (lab
 * only; Anthropic direct, D97, through the spend ledger). Input: a frequency list per language (`word count` lines,
 * most frequent first); the first `--top` purely alphabetic words of each are sent, `--batch` a call, and Haiku
 * answers each with up to three English content words (nothing for a function word or a name). Output: one JSON line
 * per word, `{w, g}`, in `--out DIR/<lang>.jsonl`, resumable (words already written are not sent again).
 *
 *   bun packages/sim/src/lab/gloss-make.ts --freq DIR --langs es,fr --top 20000 --out DIR \
 *     --spend-ledger F --spend-cap USD [--dry]
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
const FREQ = opt("freq");
const OUT = opt("out");
const LANGS = opt("langs").split(",");
const TOP = Number(opt("top", "20000"));
const BATCH = Number(opt("batch", "400"));
const MAX_TOKENS = 8_000;
const NAMES: Record<string, string> = {
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  ro: "Romanian",
  tr: "Turkish",
};
mkdirSync(OUT, { recursive: true });

const system = (lang: string) =>
  `You translate single ${NAMES[lang]} words into English for a search index. For each word give its most common ` +
  "English meanings as one to three lowercase English content words separated by spaces (base forms: a noun " +
  "singular, a verb infinitive without 'to'), most likely first. Inflected forms get the meaning of their base word. " +
  "Give an empty string for a function word (article, pronoun, preposition, conjunction, auxiliary, particle), an " +
  "interjection, a person's name, or a word you do not know. Reply with one JSON object mapping each given word to " +
  "its string, and nothing else.";

const jobs: { lang: string; words: string[] }[] = [];
for (const lang of LANGS) {
  if (!NAMES[lang]) throw new Error(`unknown language ${lang}`);
  const file = join(OUT, `${lang}.jsonl`);
  const done = new Set(
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { w: string }).w)
      : [],
  );
  const words: string[] = [];
  for (const line of readFileSync(join(FREQ, `${lang}.txt`), "utf8").split("\n")) {
    const w = line.split(" ")[0]?.toLowerCase() ?? "";
    if (!/^\p{L}{2,}$/u.test(w) || words.includes(w)) continue;
    words.push(w);
    if (words.length >= TOP) break;
  }
  const todo = words.filter((w) => !done.has(w));
  for (let i = 0; i < todo.length; i += BATCH) jobs.push({ lang, words: todo.slice(i, i + BATCH) });
}
const price = anthropicPrice(MODEL);
const bodyOf = (j: (typeof jobs)[number]) =>
  anthropicThinkingOff(
    MODEL,
    anthropicBody(
      { apiKey: "", model: MODEL },
      {
        messages: [
          { role: "system", content: system(j.lang) },
          { role: "user", content: JSON.stringify(j.words) },
        ],
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
console.log(`gloss: ${jobs.length} calls over ${LANGS.join(",")}, worst $${worst.toFixed(3)}`);
if (argv.includes("--dry")) process.exit(0);

const ledger = new SpendLedger(opt("spend-ledger"), Number(opt("spend-cap")), opt("run-label", "f1-gloss"), 0.1);
ledger.meter("f1.gloss").reserve(worst);
const headers = { "x-api-key": keyFor(MODEL), "anthropic-version": "2023-06-01", "content-type": "application/json" };
let usd = 0;
let failed = 0;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify(bodyOf(j)),
        });
        if (!res.ok) {
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
        const text = m.content.find((c) => c.type === "text")?.text ?? "";
        let got: Record<string, unknown>;
        try {
          got = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
        } catch {
          continue;
        }
        const lines = j.words
          .filter((w) => typeof got[w] === "string")
          .map((w) => JSON.stringify({ w, g: (got[w] as string).toLowerCase().trim().slice(0, 60) }));
        if (lines.length) appendFileSync(join(OUT, `${j.lang}.jsonl`), lines.join("\n") + "\n");
        ok = true;
      }
      if (!ok) failed++;
    }
  }),
);
console.log(`gloss: $${usd.toFixed(4)}, ${failed} batches failed`);
