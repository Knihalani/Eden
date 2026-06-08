/**
 * Vercel AI SDK example (streaming).
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... bun run examples/vercel-ai.ts
 *
 * Wraps the `ai` module namespace so every call to
 * `streamText` / `generateText` is instrumented.
 */

import * as ai from "ai";
import { openai } from "@ai-sdk/openai";
import { configure, wrapVercelAI, getDefaultClient } from "@eden-ai/sdk";

async function main(): Promise<void> {
  configure({
    orgId: process.env.EDEN_ORG_ID,
    apiKey: process.env.EDEN_ORG_API_KEY,
    baseUrl: process.env.EDEN_BASE_URL ?? "http://localhost:8000",
    debug: true,
    tags: ["example", "vercel-ai"],
  });

  const wrapped = wrapVercelAI(ai, { tags: ["example"] });

  const stream = await wrapped.streamText({
    model: openai("gpt-4o-mini"),
    prompt: "Say hello in one short sentence.",
  });

  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");

  await getDefaultClient().dispose();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
