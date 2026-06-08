/**
 * LangChain chat-model example.
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... bun run examples/langchain.ts
 *
 * Wraps a LangChain `ChatOpenAI` instance via `wrapLangChain` so
 * every `.invoke()` and `.stream()` call emits telemetry.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import { configure, wrapLangChain, getDefaultClient } from "@eden-ai/sdk";

async function main(): Promise<void> {
  configure({
    orgId: process.env.EDEN_ORG_ID,
    apiKey: process.env.EDEN_ORG_API_KEY,
    baseUrl: process.env.EDEN_BASE_URL ?? "http://localhost:8000",
    debug: true,
    tags: ["example", "langchain"],
  });

  const raw = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
  const chat = wrapLangChain(raw, { tags: ["example"] });

  const result = await chat.invoke([
    new HumanMessage("Say hello in one short sentence."),
  ]);
  // eslint-disable-next-line no-console
  console.log("reply:", result.content);

  await getDefaultClient().dispose();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
