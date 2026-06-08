/**
 * Basic OpenAI chat example.
 *
 * Run with:
 *   OPENAI_API_KEY=sk-... bun run examples/basic-chat.ts
 *
 * For local dev (no gateway) the SDK is a no-op when `orgId` is
 * not configured. Set `EDEN_ORG_ID` and `EDEN_ORG_API_KEY` env
 * vars to send real telemetry to the gateway.
 */

import OpenAI from "openai";
import { configure, wrapOpenAI, getDefaultClient } from "@eden-ai/sdk";

async function main(): Promise<void> {
  configure({
    orgId: process.env.EDEN_ORG_ID,
    apiKey: process.env.EDEN_ORG_API_KEY,
    baseUrl: process.env.EDEN_BASE_URL ?? "http://localhost:8000",
    debug: true,
    tags: ["example", "basic-chat"],
  });

  const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const client = wrapOpenAI(raw, { tags: ["example"] });

  const reply = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "Say hello in one short sentence." },
    ],
  });
  // eslint-disable-next-line no-console
  console.log("reply:", reply.choices[0]?.message?.content);

  // Ensure queued events flush before the process exits.
  await getDefaultClient().dispose();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
