import { expect, test } from "bun:test";
import { capped, RequestCapReached, type RequestCap } from "./request-cap";

const ok = (async () => new Response("{}")) as unknown as typeof fetch;
const CHAT = "https://openrouter.ai/api/v1/chat/completions";

test("chat requests past the cap fail without being sent; other URLs pass", async () => {
  let sent = 0;
  const inner = (async () => {
    sent++;
    return new Response("{}");
  }) as unknown as typeof fetch;
  const cap: RequestCap = { max: 2, gapMs: 0, sent: 0, refused: 0 };
  const f = capped(inner, cap);
  await f(CHAT);
  await f(CHAT);
  await expect(f(CHAT)).rejects.toBeInstanceOf(RequestCapReached);
  await f("https://example.com/other");
  expect(sent).toBe(3);
  expect(cap).toMatchObject({ sent: 2, refused: 1 });
});

test("concurrent requests start at least a gap apart", async () => {
  // Three requests at once, on a clock that stands still: the second waits one gap, the third two.
  const waits: number[] = [];
  const cap: RequestCap = { max: 10, gapMs: 3_000, sent: 0, refused: 0 };
  const f = capped(
    ok,
    cap,
    async (ms) => {
      waits.push(ms);
    },
    () => 0,
  );
  await Promise.all([f(CHAT), f(CHAT), f(CHAT)]);
  expect(waits).toEqual([3_000, 6_000]);
});
