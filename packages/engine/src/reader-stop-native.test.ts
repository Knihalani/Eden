import { expect, test } from "bun:test";
import { OpenRouterModel } from "@eden/llm";
import { ModelReaderMaker, READER_STOP } from "./reader";

// Audit A5, fixed (D240, unverified provider behaviour): OpenRouter's `native_finish_reason` is the upstream provider's
// own word. Anthropic says "stop_sequence" for a stop hit, but OpenAI-style providers say "stop" for both a stop
// sequence and a natural end (and Google says "STOP"). `OpenRouterModel` maps any reason other than "stop_sequence" to
// `stopped: false`, so with an `EDEN_MODEL` override on such a provider every reply the stop cut is never closed by
// `closeStopped`: the reader's whole verdict (its binding entries included) is lost as "unreadable".

test("a stop-cut reply from a provider whose native reason for a stop hit is 'stop' still yields the bearing", async () => {
  // The model wrote a binding entry, then began a lookalike; the stop sequence cut it there.
  const cut =
    '{"bears":[{"i":0,"why":"account frozen until Friday","same":true,"binds":true,"k":"blocks"},{"i":1,"why":"other account",';
  const fake = (async () =>
    Response.json({
      choices: [{ message: { content: cut }, finish_reason: "stop", native_finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.0001 },
    })) as unknown as typeof fetch;
  const model = new OpenRouterModel({ apiKey: "k", model: "openai/gpt-5-mini", fetch: fake });
  const maker = new ModelReaderMaker(model);
  const item = (id: string) => ({ id, source: "mail", title: id, date: "2026-11-01", from: "", text: id, hash: id });
  const got = await maker.read(
    { request: "pay from the main account", items: [item("a"), item("b")], today: "2026-11-07", stopEarly: true },
    new AbortController().signal,
  );
  expect(READER_STOP).toBe('"same":false');
  // Bug: bears is null (the reading is lost) because `stopped` came back false.
  expect(got.bears?.map((b) => b.i)).toEqual([0]);
});
