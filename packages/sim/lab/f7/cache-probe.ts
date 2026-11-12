// D1196's probe: does the shipped OpenRouter route cache the push check's stable prefix?
// It makes four real push-check calls through the server's own model roles, with EDEN_MODEL_CACHE=on:
// two with one session_id a few seconds apart (one user's reuse), then two with different session_ids (other users).
// It prints each call's prompt tokens, cached tokens and cost, never the key. Spend: well under a cent.
//
//   EDEN_ALLOW_OPENROUTER=1 bun packages/sim/lab/f7/cache-probe.ts
import { checkMessages } from "@eden/engine";
import { modelRolesFromEnv } from "@eden/server";

if (!process.env.OPENROUTER_API_KEY) {
  console.error("cache-probe: OPENROUTER_API_KEY is not set");
  process.exit(2);
}
const roles = modelRolesFromEnv({ ...process.env, EDEN_MODEL_CACHE: "on" });
const reader = roles.reader;
if (!reader) throw new Error("cache-probe: no reader role");

const items = [
  {
    id: "a",
    hash: "1",
    source: "mail",
    title: "Payments on hold",
    text: "All supplier payments are on hold until the audit closes Friday.",
    date: "2026-11-10",
    from: "finance",
  },
  {
    id: "b",
    hash: "2",
    source: "calendar",
    title: "Lunch with Ana",
    text: "Lunch with Ana at 1pm Thursday.",
    date: "2026-11-11",
    from: "",
  },
];
const call = async (label: string, session: string, request: string) => {
  const res = await reader.chat({
    messages: checkMessages({ request, today: "2026-11-12", items }),
    maxTokens: 120,
    json: true,
    cacheKey: session,
  });
  const u = res.usage;
  console.log(
    `${label.padEnd(26)} prompt ${String(u.inputTokens).padStart(5)}  cached ${String(u.cachedInputTokens).padStart(5)}  ` +
      `out ${String(u.outputTokens).padStart(4)}  $${(res.costUsd ?? 0).toFixed(6)}`,
  );
  return u.cachedInputTokens;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const a1 = await call("same session, first", "probe-user-a", "Pay the Harlow invoice today");
await sleep(3000);
const a2 = await call("same session, second", "probe-user-a", "Book a table for lunch Thursday");
await sleep(3000);
const b1 = await call("other session, first", "probe-user-b", "Pay the Harlow invoice today");
await sleep(3000);
const c1 = await call("third session, first", "probe-user-c", "Move the dentist to next week");
console.log(JSON.stringify({ sameSessionCached: a2 > 0, crossUserCached: b1 > 0 || c1 > 0, a1, a2, b1, c1 }));
