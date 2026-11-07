import { afterAll, describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy } from "./proxy";

// Audit A5 on A4's proxy (D280): each test states what D280 and packages/proxy/CLAUDE.md promise; each failed
// before its fix.

const KEY = "k_proxy_a5_0123456789abcd";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
  { ref: "evt-dentist", title: "Dentist", text: "Dr. Okafor, Friday 9:00-10:00" },
]);
const sourceMap = new SourceMap();
const partner = buildPartner({ sources: async () => [sources], model: null, sourceMap });
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

const chat = (proxy: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string>) =>
  proxy(
    new Request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-upstream", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
const explain = async (userId: string, sessionId: string) =>
  (
    (await (
      await fetch(`${eden.url.href}v1/explain`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ userId, sessionId }),
      })
    ).json()) as { decisions: { event: string; turn: number; decision: string }[] }
  ).decisions;

describe("audit A5: proxy (D280)", () => {
  test("a user message repeated verbatim in a later turn is reported; the same request again is a retry", async () => {
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 500,
    });
    const h = { "x-eden-user-id": "ua", "x-eden-session-id": "sa" };
    // An agent that sends each turn alone (or whose window slid past the first "continue").
    const say = (content: string) => chat(proxy, { model: "m", messages: [{ role: "user", content }] }, h);
    await say("What time is lunch with Priya Raman?");
    await say("continue");
    await say("Is the Globex renewal signed?");
    await say("continue"); // a new turn: was dropped as already seen
    await say("continue"); // the same request again: a retry, indistinguishable from a repeat, so not reported
    const userEvents = (await explain("ua", "sa")).filter(
      (d) => d.event === "user_message" && d.decision !== "reader-push",
    );
    expect(userEvents.length).toBe(4);
  });

  test("a stateless repeat does not carry the previous turn's packet into the new turn", async () => {
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 500,
    });
    const h = { "x-eden-user-id": "ub", "x-eden-session-id": "sb" };
    await chat(proxy, { model: "m", messages: [{ role: "user", content: "yes" }] }, h);
    await chat(proxy, { model: "m", messages: [{ role: "user", content: "What time is lunch with Priya Raman?" }] }, h);
    const second = seen.at(-1).messages;
    expect(JSON.stringify(second)).toContain("Dishoom"); // turn 2 got its packet
    // Turn 3: the user says "yes" again (a new turn). The turn-2 packet belongs to turn 2 (packets are per turn, D280).
    await chat(proxy, { model: "m", messages: [{ role: "user", content: "yes" }] }, h);
    expect(JSON.stringify(seen.at(-1).messages)).not.toContain("Dishoom");
  });

  test("shadow mode leaves Eden's learned source utility untouched (a no-risk trial, D280)", async () => {
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 1_000,
      shadow: true,
      onShadow: () => {},
    });
    const h = { "x-eden-user-id": "uc", "x-eden-session-id": "sc" };
    const msgs: { role: string; content: string }[] = [
      { role: "user", content: "What time is lunch with Priya Raman?" },
    ];
    await chat(proxy, { model: "m", messages: msgs }, h);
    // The agent never saw the packet (shadow). The conversation goes on for a few turns.
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: "assistant", content: `reply number ${i} about the weather` });
      msgs.push({ role: "user", content: `thanks, next point ${i}` });
      await chat(proxy, { model: "m", messages: msgs }, h);
    }
    sourceMap.flush();
    const rows = (sourceMap as any).db
      .query("SELECT situation, source_id, shown, used FROM utility WHERE scope = ?")
      .all("acme/uc") as unknown[];
    // Packets the agent was never shown must not be learned as "shown and unused".
    expect(rows).toEqual([]);
  });
});

describe("audit A5: proxy re-serialises the body when it injects", () => {
  test("fields the proxy does not touch reach the upstream byte-for-byte (a 64-bit seed)", async () => {
    let raw = "";
    const up = Bun.serve({
      port: 0,
      async fetch(req) {
        raw = await req.text();
        return Response.json({ ok: true });
      },
    });
    try {
      const proxy = createProxy({
        upstream: `${up.url.href}v1`,
        edenUrl: eden.url.href,
        edenApiKey: KEY,
        waitMs: 1_000,
      });
      const body =
        '{"model":"m","seed":12345678901234567890,"messages":[{"role":"user","content":"What time is lunch with Priya Raman?"}]}';
      await proxy(
        new Request("http://proxy/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-eden-user-id": "ud", "x-eden-session-id": "sd" },
          body,
        }),
      );
      expect(raw).toContain("Dishoom"); // Eden injected
      expect(raw).toContain('"seed":12345678901234567890');
    } finally {
      up.stop(true);
    }
  });
});
