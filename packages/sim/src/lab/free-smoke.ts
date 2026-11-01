#!/usr/bin/env bun
/**
 * The free-model smoke test (docs/research/edge-freelab.md): one tiny JSON-mode request to each model named, through
 * the lab's pacer and logging choice (`free.ts`) and Eden's own `OpenRouterModel`, so a broken route, key, rate limit
 * or JSON mode shows before a run spends its requests. Sim text only. Lab only.
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/free-smoke.ts --allow-logging \
 *     [--models nvidia/nemotron-3.5-super-vl:free,cohere/north-mini-code:free] [--max-requests 6] [--rpm 18]
 *
 * Each model's line: ok or the error, the latency, the endpoint that served it, its cost, whether the reply was JSON.
 * Costs one request a model (more only when one is retried on a 429 or 5xx; `--max-requests` bounds them).
 */
import { labAccess, labModel } from "./free";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const MODELS = opt("models", "nvidia/nemotron-3.5-super-vl:free").split(",").filter(Boolean);
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("needs OPENROUTER_API_KEY");
// A default cap of two requests a model: one, and one retry.
const capped = args.includes("--max-requests") ? args : [...args, "--max-requests", String(MODELS.length * 2)];
const access = labAccess(capped, MODELS);

for (const id of MODELS) {
  const model = labModel(access, { apiKey: KEY, model: id, timeoutMs: 120_000 });
  try {
    const res = await model.chat({
      messages: [
        { role: "system", content: 'Reply with JSON only: {"ok": true, "sum": <the sum>}.' },
        { role: "user", content: "What is 2 + 3?" },
      ],
      maxTokens: 400,
      json: true,
    });
    let json = false;
    try {
      const t = res.text;
      json = typeof JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) === "object";
    } catch {}
    console.log(
      `${id}: ok ${res.latencyMs}ms via ${res.provider ?? "?"}, $${res.costUsd}, ` +
        `${res.usage.inputTokens} in / ${res.usage.outputTokens} out, json ${json}: ${res.text.slice(0, 80)}`,
    );
  } catch (e) {
    console.log(`${id}: FAILED ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}
console.log(`requests: ${JSON.stringify(access.pacer.summary())}`);
