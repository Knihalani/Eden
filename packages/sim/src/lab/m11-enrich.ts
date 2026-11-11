/**
 * M11 (D970-D979, lab only): Haiku's intent requests for M2 synthetic items, once, as training targets for the micro
 * expansion (the shipped card + intent prompt, `ModelCardMaker` with intent, batches of 20 as `cardsEconomy` sends).
 * Every item of the given worlds (redacted as the cache holds it) is sent; lines `{h, title, text, terms, titleTerms,
 * r, c}` go to OUT, and items already there are skipped. Anthropic only, through the spend ledger.
 *   bun packages/sim/src/lab/m11-enrich.ts --worlds .local/m2/synth/worlds/train.jsonl --out .local/m11/m2-intent.jsonl \
 *     --model claude-haiku-5-5 --spend-ledger .local/m11/ledger.jsonl --spend-cap 2.5 [--concurrency 6] [--max-items N]
 * Never the test split (D884).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cardKey, intentTerms, ModelCardMaker, sanitizeItem } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { isCapError, keyFor, labAccess, labModel } from "./free";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1]! : d);
const WORLDS = opt("worlds", "");
const OUT = opt("out", "");
const MODEL = opt("model", "claude-haiku-5-5");
if (!WORLDS || !OUT || /test/.test(WORLDS)) throw new Error("--worlds (never test) and --out are required");
const ACCESS = labAccess(args, [MODEL]);
const done = new Set<string>();
if (existsSync(OUT))
  for (const l of readFileSync(OUT, "utf8").split("\n")) if (l.trim()) done.add((JSON.parse(l) as { h: string }).h);
const todo: [string, ContextItem][] = [];
const seen = new Set<string>(done);
for (const line of readFileSync(WORLDS, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const w = JSON.parse(line) as { id: string; items: { id: string; source: string; title: string; text: string }[] };
  for (const it of w.items) {
    const s = sanitizeItem({ id: `${w.id}:${it.id}`, sourceId: it.source, ref: it.id, title: it.title, text: it.text });
    const h = cardKey(s);
    if (seen.has(h)) continue;
    seen.add(h);
    todo.push([h, s]);
  }
}
const MAX = Number(opt("max-items", "0"));
if (MAX > 0) todo.splice(MAX);
const BATCH = 20;
console.log(`m11-enrich: ${todo.length} items to read (${done.size} done), ${Math.ceil(todo.length / BATCH)} calls`);
const model = labModel(ACCESS, { apiKey: keyFor(MODEL), model: MODEL, timeoutMs: 120_000 }, "m11.intent");
const maker = new ModelCardMaker(model, { maxTokens: 8000 });
let next = 0;
let calls = 0;
let failed = 0;
let stopped = false;
const today = "2026-10-27";
const worker = async () => {
  while (next < todo.length && !stopped) {
    const batch = todo.slice(next, next + BATCH);
    next += BATCH;
    try {
      const made = await maker.make(
        batch.map(([, it]) => it),
        today,
        new AbortController().signal,
        false,
        true,
      );
      calls++;
      const lines = batch.map(([h, it], i) =>
        JSON.stringify({
          h,
          title: it.title,
          text: it.text,
          terms: intentTerms(`${it.title}\n${it.text}`),
          titleTerms: intentTerms(it.title),
          r: made.requests?.[i] ?? [],
          c: made.cards[i] ?? null,
        }),
      );
      appendFileSync(OUT, `${lines.join("\n")}\n`);
    } catch (e) {
      if (isCapError(e)) stopped = true;
      else failed++;
    }
    if (calls % 50 === 0) console.log(`calls ${calls}, failed ${failed}`);
  }
};
await Promise.all(Array.from({ length: Number(opt("concurrency", "6")) }, worker));
console.log(`m11-enrich: calls ${calls}, failed ${failed}${stopped ? ", stopped at the cap" : ""}`);
