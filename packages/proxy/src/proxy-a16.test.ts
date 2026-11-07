import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy } from "./proxy";

// A16 (D336, `keepPackets`, on by default): a packet the agent saw stays where it was on every later request, so the request
// the upstream gets is the previous one plus what is new and the provider's prompt cache reads the history instead of
// writing it again (docs/research/a16-loop.md: dropping it rewrote the whole session on Anthropic's cache).

const KEY = "k_proxy_a16_0123456789abcd";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
  { ref: "evt-dentist", title: "Dentist", text: "Dr. Okafor, Friday 9:00-10:00" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });
const seen: any[] = [];
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push(JSON.parse(await req.text()));
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
  partner.stopSync();
});

const proxyFor = (keepPackets: boolean, edenUrl = eden.url.href) =>
  createProxy({ upstream: `${upstream.url.href}v1`, edenUrl, edenApiKey: KEY, waitMs: 1_000, keepPackets });
const chat = (proxy: (r: Request) => Promise<Response>, messages: unknown[], headers: Record<string, string>) =>
  proxy(
    new Request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-upstream", "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "m", messages }),
    }),
  );

const system = { role: "system", content: "You are helpful." };
const q1 = { role: "user", content: "What time is lunch with Priya Raman?" };
const a1 = { role: "assistant", content: "Thursday 12:30 at Dishoom." };
const q2 = { role: "user", content: "And when is the dentist, Dr. Okafor?" };
const a2 = { role: "assistant", content: "Friday at 9:00." };
const q3 = { role: "user", content: "Thanks, anything else today?" };

/** Two requests of one conversation; the upstream messages each one got. */
async function session(keepPackets: boolean, user: string, edenUrl?: string) {
  const proxy = proxyFor(keepPackets, edenUrl);
  const h = { "x-eden-user-id": user, "x-eden-session-id": `${user}-s` };
  await chat(proxy, [system, q1], h);
  const first = seen.at(-1)!.messages;
  await chat(proxy, [system, q1, a1, q2], h);
  const second = seen.at(-1)!.messages;
  return { proxy, h, first, second };
}

describe("keepPackets (D336)", () => {
  test("off (the opt-out, and the proxy before D336): the first turn's packet is gone from the second request, so it is not a prefix of it", async () => {
    const { first, second } = await session(false, "k-off");
    expect(first.map((m: any) => m.role)).toEqual(["system", "system", "user"]);
    expect(first[1].content).toContain("Dishoom");
    expect(second.slice(0, first.length)).not.toEqual(first);
    expect(JSON.stringify(second)).not.toContain("Dishoom, confirmed");
  });

  test("on by default", async () => {
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 1_000,
    });
    const h = { "x-eden-user-id": "k-default", "x-eden-session-id": "k-default-s" };
    await chat(proxy, [system, q1], h);
    const first = seen.at(-1)!.messages;
    await chat(proxy, [system, q1, a1, q2], h);
    expect(seen.at(-1)!.messages.slice(0, first.length)).toEqual(first);
  });

  test("on: every earlier packet stays where it was, and each request starts with the one before it", async () => {
    const { proxy, h, first, second } = await session(true, "k-on");
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.map((m: any) => m.role)).toEqual(["system", "system", "user", "assistant", "system", "user"]);
    expect(second[4].content).toContain("Okafor");
    // A turn with nothing new from Eden still keeps the earlier packets in place.
    await chat(proxy, [system, q1, a1, q2, a2, q3], h);
    const third = seen.at(-1)!.messages;
    expect(third.slice(0, second.length)).toEqual(second);
  });

  test("on, with Eden down: the packets it already gave stay in place (nothing new is asked of Eden)", async () => {
    // Its own Eden, stopped after two turns: what the proxy placed it keeps without asking Eden again.
    const own = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });
    const { proxy, h, second } = await session(true, "k-down", own.url.href);
    own.stop(true);
    await chat(proxy, [system, q1, a1, q2, a2, q3], h);
    const third = seen.at(-1)!.messages;
    expect(third.slice(0, second.length)).toEqual(second);
    expect(third.at(-1)).toEqual(q3);
  });

  test("on: kept packets are per conversation (D9), and a user message seen twice keeps each copy's own packet", async () => {
    const a = await session(true, "k-iso-a");
    const proxy = proxyFor(true);
    // Another user, the same words: none of user a's packets.
    await chat(proxy, [system, q1, a1, q2], { "x-eden-user-id": "k-iso-b", "x-eden-session-id": "k-iso-a-s" });
    const other = seen.at(-1)!.messages;
    expect(other.filter((m: any) => m.role === "system").length).toBeLessThanOrEqual(2);
    expect(a.second.filter((m: any) => m.role === "system").length).toBe(3);
  });

  test("on, in shadow mode: nothing is inserted, kept or not", async () => {
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 1_000,
      keepPackets: true,
      shadow: true,
    });
    const h = { "x-eden-user-id": "k-shadow", "x-eden-session-id": "k-shadow-s" };
    await chat(proxy, [system, q1], h);
    await chat(proxy, [system, q1, a1, q2], h);
    expect(seen.at(-1)!.messages).toEqual([system, q1, a1, q2]);
  });
});
