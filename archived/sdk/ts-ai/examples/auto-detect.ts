/**
 * Auto-detect installed LLM SDKs and wrap what's available.
 *
 * Run with:
 *   bun add openai @anthropic-ai/sdk ai @langchain/core  # any subset
 *   OPENAI_API_KEY=sk-... bun run examples/auto-detect.ts
 *
 * The example calls `detectInstalledFrameworks()` to find out which
 * LLM SDKs are importable, then dynamically imports + wraps the ones
 * that are present. This is the idiomatic pattern when the consumer
 * code doesn't know in advance which frameworks a downstream user will
 * have installed.
 */

import {
  configure,
  detectInstalledFrameworks,
  getDefaultClient,
  type AutoInstrumentResult,
} from "@eden-ai/sdk";

async function main(): Promise<void> {
  configure({
    orgId: process.env.EDEN_ORG_ID,
    apiKey: process.env.EDEN_ORG_API_KEY,
    baseUrl: process.env.EDEN_BASE_URL ?? "https://api.edenobservability.com",
    debug: false,
  });

  const detected: AutoInstrumentResult = detectInstalledFrameworks();
  const installed = (Object.keys(detected) as Array<keyof AutoInstrumentResult>)
    .filter((k) => detected[k]);
  console.log("Detected installed LLM SDKs:", installed);

  // Only OpenAI is wrapped in this example for brevity.  Add the
  // rest in the same pattern.
  if (detected.openai) {
    const { default: OpenAI } = await import("openai");
    const { wrapOpenAI } = await import("@eden-ai/sdk/instrumentations/openai");
    const raw = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const client = wrapOpenAI(raw, { tags: ["example", "auto-detect"] });
    const reply = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise assistant." },
        { role: "user", content: "Say hi in one short sentence." },
      ],
      max_tokens: 64,
    });
    console.log("openai reply:", reply.choices[0]?.message?.content);
  } else {
    console.log("openai not installed; skipping the demo chat.");
  }

  await getDefaultClient().flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
