/**
 * Mastra agent with Eden wrapMastra instrumentation.
 *
 * Run with:
 *   bun add @eden-ai/sdk @mastra/core
 *   EDEN_ORG_ID=org_x EDEN_ORG_API_KEY=sk_... bun run examples/mastra.ts
 */

import { configure, getDefaultClient, instrument, wrapMastra } from "@eden-ai/sdk";

async function main(): Promise<void> {
  configure({
    orgId: process.env.EDEN_ORG_ID,
    apiKey: process.env.EDEN_ORG_API_KEY,
    baseUrl: process.env.EDEN_BASE_URL ?? "http://localhost:8000",
  });

  instrument();

  let mastraMod: { Mastra?: new (...args: unknown[]) => object } | null = null;
  try {
    mastraMod = await import("@mastra/core");
  } catch {
    console.log("@mastra/core not installed — showing wrapMastra pattern only");
    await getDefaultClient().flush();
    return;
  }

  const Mastra = mastraMod.Mastra;
  if (!Mastra) {
    console.log("Mastra export not found in @mastra/core");
    return;
  }

  const mastra = wrapMastra(
    new Mastra({
      name: "eden-mastra-example",
    }),
    { tags: ["example", "mastra"] },
  );

  console.log("Wrapped Mastra instance — agent/workflow calls emit source_format=mastra");
  console.log("mastra keys:", Object.keys(mastra as object).slice(0, 5));
  await getDefaultClient().flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
