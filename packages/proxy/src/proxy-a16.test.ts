import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy } from "./proxy";

// A16 (D336, `keepPackets`, on by default): a packet the agent saw stays where it was on every later request, so the
// request the upstream gets is the previous one plus what is new and the provider's prompt cache reads the history
// instead of writing it again (docs/research/a16-loop.md: dropping it rewrote the whole session on Anthropic's cache).

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

  test("on: kept packets are per conversation (D9)", async () => {
    const a = await session(true, "k-iso-a");
    expect(a.second.filter((m: any) => m.role === "system").length).toBe(3);
    // Another user on the same proxy, the same words and session id: user a's turn-1 packet is not placed before q1.
    await chat(a.proxy, [system, q1, a1, q2], { "x-eden-user-id": "k-iso-b", "x-eden-session-id": "k-iso-a-s" });
    const other = seen.at(-1)!.messages;
    expect(other.slice(0, 2)).toEqual([system, q1]);
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

// A scripted Eden: each user message's text maps to the packet it returns (none if absent), after `delays[text]` ms.
// The review's probes of keepPackets' keying, overlapping turns and the budget (findings 1–3, 6).
const script: Record<string, string> = {};
const delays: Record<string, number> = {};
/** Packets the fake's `/v1/pending` hands out once, per user id. */
const pendingFor: Record<string, string> = {};
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as { kind?: string; text?: string };
    if (url.pathname === "/v1/pending") {
      const who = (body as { userId?: string }).userId ?? "";
      const packet = pendingFor[who];
      delete pendingFor[who];
      return Response.json({ injections: packet ? [{ id: `i-${packet}`, text: packet }] : [] });
    }
    if (url.pathname !== "/v1/events" || body.kind !== "user_message") return Response.json({ injection: null });
    const text = body.text ?? "";
    if (delays[text]) await Bun.sleep(delays[text]);
    const packet = script[text];
    return Response.json({ injection: packet ? { id: `i-${packet}`, text: packet } : null });
  },
});
afterAll(() => fake.stop(true));

const scripted = (maxKeptBytes?: number) =>
  createProxy({
    upstream: `${upstream.url.href}v1`,
    edenUrl: fake.url.href,
    edenApiKey: KEY,
    waitMs: 300,
    ...(maxKeptBytes ? { maxKeptBytes } : {}),
  });
const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });
const shape = (msgs: any[]) => msgs.map((m) => (m.role === "system" ? `[${m.content}]` : m.content));

describe("keepPackets: placement survives windows, new turns and overlap (the review)", () => {
  test("a repeated message keeps its own packet when a window drops the first copy", async () => {
    Object.assign(script, { "yes#1": "", yes: "PKT-YES" });
    const p = scripted();
    const h = { "x-eden-user-id": "w1", "x-eden-session-id": "w1-s" };
    script.yes = "PKT-T2";
    await chat(p, [u("start"), a("r1"), u("yes")], h);
    script.yes = "PKT-T4";
    await chat(p, [u("start"), a("r1"), u("yes"), a("r2"), u("other"), a("r3"), u("yes")], h);
    // The window slides past turn 2: turn 4's "yes" (after "r3") keeps turn 4's packet.
    script.next = "";
    await chat(p, [u("other"), a("r3"), u("yes"), a("r4"), u("next")], { ...h });
    expect(shape(seen.at(-1)!.messages)).toEqual(["other", "r3", "[PKT-T4]", "yes", "r4", "next"]);
  });

  test("a new turn repeating an old turn's words gets no old packet (an agent that sends only its latest)", async () => {
    const p = scripted();
    const h = { "x-eden-user-id": "w2", "x-eden-session-id": "w2-s" };
    script.continue = "PKT-OLD";
    await chat(p, [u("continue")], h);
    expect(shape(seen.at(-1)!.messages)).toEqual(["[PKT-OLD]", "continue"]);
    await chat(p, [u("something else")], h);
    script.continue = "";
    await chat(p, [u("continue")], h);
    expect(shape(seen.at(-1)!.messages)).toEqual(["continue"]);
  });

  test("a request overtaken by a newer turn neither shows nor keeps that turn's packets", async () => {
    const p = scripted();
    const h = { "x-eden-user-id": "w3", "x-eden-session-id": "w3-s" };
    Object.assign(script, { "first q": "PKT-FIRST", "second q": "PKT-SECOND", "third q": "" });
    delays["first q"] = 700;
    const slow = chat(p, [u("first q")], h);
    await Bun.sleep(50);
    await chat(p, [u("first q"), a("x"), u("second q")], h);
    await slow;
    await chat(p, [u("first q"), a("x"), u("second q"), a("y"), u("third q")], h);
    const last = shape(seen.at(-1)!.messages);
    expect(last.filter((t) => t === "[PKT-SECOND]")).toHaveLength(1);
    expect(last).toEqual(["first q", "x", "[PKT-SECOND]", "second q", "y", "third q"]);
  });

  test("over the budget, placements no longer in the request go first; the newest is kept in place", async () => {
    const p = scripted(25);
    const h = { "x-eden-user-id": "w4", "x-eden-session-id": "w4-s" };
    Object.assign(script, { q1: "P1-xxxxxxx", q2: "P2-xxxxxxx", q3: "P3-xxxxxxx", q4: "" });
    await chat(p, [u("q1")], h);
    await chat(p, [u("q1"), a("r1"), u("q2")], h);
    // A compacted history: q1's placement is no longer in the request, so it makes room for q3's.
    await chat(p, [u("q2"), a("r2"), u("q3")], h);
    await chat(p, [u("q2"), a("r2"), u("q3"), a("r3"), u("q4")], h);
    expect(shape(seen.at(-1)!.messages)).toEqual(["q2", "r2", "[P3-xxxxxxx]", "q3", "r3", "q4"]);
  });

  test("a request with no user message still gets this turn's packets, where withContext puts them", async () => {
    const p = scripted();
    // Only system and assistant messages: the packet comes from pending, and goes at the end as withContext puts it.
    pendingFor.w5 = "PKT-LATE";
    await chat(p, [{ role: "system", content: "s" }, a("hello")], {
      "x-eden-user-id": "w5",
      "x-eden-session-id": "w5-s",
    });
    expect(shape(seen.at(-1)!.messages)).toEqual(["[s]", "hello", "[PKT-LATE]"]);
  });
});
