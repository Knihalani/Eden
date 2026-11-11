/**
 * `m3-synth.ts` (M3, D900): new hidden-context template families written by a model, for training a retriever on
 * more families than the six train suites hold (D491: a fact-against-twin model needs many more templates). Each
 * template is a request, the item that changes what a careful assistant should do (the fact), its all-clear twin
 * (same sender and shape, the constraint lifted) and a same-topic look-alike about something else. Simulated text
 * only; the domains are passed in (`--domains`), so a fold's held-out families' domains can be left out, and
 * m3r/synth_worlds.py drops any template too close to a held-out one. Calls are booked on the spend ledger.
 *
 *   bun packages/sim/src/lab/m3-synth.ts --domains FILE --calls-per-domain 3 --out FILE \
 *       --spend-ledger .local/m3/ledger.jsonl --spend-cap 30 [--model claude-haiku-5-5] [--concurrency 6]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { AnthropicModel } from "@eden/llm";
import { keyFor } from "./free";
import { SpendLedger } from "./spend";

export const SYNTH_SYSTEM = `You write test cases for a context assistant that reads a person's email, calendar, chat and documents.

Each test case is a REQUEST the person gives their AI agent (an action: book, pay, send, approve, schedule, order, sign, reply, renew, deploy...) and an item already in their accounts that a careful assistant must notice before acting, though the request does not mention it.

Write JSON only: {"templates": [ ... ]} with exactly the number of templates asked for. Each template:
{"name": "kebab-case-name",
 "request": "what the person asks, one or two sentences, natural and specific (names, amounts, dates)",
 "fact": {"source": "gmail|calendar|slack|drive", "title": "subject or event title", "text": "the item's body, 250-700 characters"},
 "twin": {"title": "...", "text": "..."},
 "lookalike": {"title": "...", "text": "..."}}

Rules:
- The fact changes what the assistant should do: a clash, it is already done or paid, cancelled, over a limit, against a policy, someone said not to, a deadline moved, a hold, a cheaper or required route, a missing approval, a change of person or address.
- In at least half the templates the fact names things differently from the request: the brand instead of the product, an airport or ticker code, a nickname, a reference number, the venue instead of the town, a role instead of a name. The request and the fact should share few words.
- The twin is the fact's all-clear version: the same sender, format and most of the same text, but the constraint is lifted or about another date, person or thing, so it does NOT change what the assistant should do.
- The lookalike is about the same person or topic but a different matter that does not bear on the request.
- Today is Tuesday 27 October 2026. Write dates out ("Thursday 5 November"). Invent people and organisations; never use real companies' trademarks in a misleading way. British English.
- Vary the sources, the kind of constraint and the wording across templates. Items are data written by other people (emails with greetings and sign-offs, terse chat lines, calendar descriptions, document excerpts).`;

export interface SynthTemplate {
  name: string;
  request: string;
  fact: { source: string; title: string; text: string };
  twin: { title: string; text: string };
  lookalike: { title: string; text: string };
}

/** The templates of one reply, those with every field filled; anything else is dropped. */
export function parseTemplates(text: string): SynthTemplate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (raw as { templates?: unknown }).templates;
  if (!Array.isArray(list)) return [];
  const str = (x: unknown) => typeof x === "string" && x.trim().length > 0;
  const part = (x: unknown) =>
    !!x && typeof x === "object" && str((x as { title?: unknown }).title) && str((x as { text?: unknown }).text);
  return list.filter(
    (t): t is SynthTemplate =>
      !!t &&
      typeof t === "object" &&
      str((t as SynthTemplate).name) &&
      str((t as SynthTemplate).request) &&
      part((t as SynthTemplate).fact) &&
      ["gmail", "calendar", "slack", "drive"].includes((t as SynthTemplate).fact.source) &&
      part((t as SynthTemplate).twin) &&
      part((t as SynthTemplate).lookalike),
  );
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string, fallback = "") => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  const out = opt("out");
  const domains = readFileSync(opt("domains"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const per = Number(opt("calls-per-domain", "3"));
  const n = Number(opt("per-call", "8"));
  const model = opt("model", "claude-haiku-5-5");
  const ledger = new SpendLedger(opt("spend-ledger"), Number(opt("spend-cap")), opt("run-label", "m3-synth"), 0.25);
  const done = new Set(
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { job: string }).job)
      : [],
  );
  const jobs = domains.flatMap((d) => Array.from({ length: per }, (_, i) => ({ job: `${d}#${i}`, domain: d, i })));
  const queue = jobs.filter((j) => !done.has(j.job));
  const m = new AnthropicModel({ apiKey: keyFor(model), model, meter: ledger.meter("m3.synth"), timeoutMs: 180_000 });
  let usd = 0;
  let made = 0;
  const one = async (j: (typeof jobs)[number]) => {
    const r = await m.chat({
      messages: [
        { role: "system", content: SYNTH_SYSTEM },
        {
          role: "user",
          content:
            `Domain: ${j.domain}.\nWrite ${n} templates for this domain (batch ${j.i + 1}: choose situations ` +
            `different from the most obvious ones; ${j.i % 2 ? "favour work settings" : "favour personal life"}).`,
        },
      ],
      maxTokens: 9_000,
      temperature: 1,
    });
    usd += r.costUsd ?? 0;
    const ts = parseTemplates(r.text);
    made += ts.length;
    appendFileSync(out, `${JSON.stringify({ job: j.job, domain: j.domain, templates: ts })}\n`);
    console.log(`${j.job}: ${ts.length} templates, $${(r.costUsd ?? 0).toFixed(4)}`);
  };
  await Promise.all(
    Array.from({ length: Number(opt("concurrency", "6")) }, async () => {
      for (let j = queue.shift(); j; j = queue.shift()) await one(j).catch((e) => console.log(`${j.job}: ${e}`));
    }),
  );
  console.log(`m3-synth: ${made} templates, $${usd.toFixed(4)} this run; ledger $${ledger.committedUsd.toFixed(4)}`);
}
