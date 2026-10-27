import { describe, expect, test } from "bun:test";
import type { Injection } from "@eden/protocol";
import { EdenClient } from "./client";
import { withContext } from "./messages";

const inj = (text: string) => ({ id: "inj_1", text }) as Injection;

describe("EdenClient", () => {
  test("fails open: a dead server means no context, not an exception", async () => {
    const errors: unknown[] = [];
    const eden = new EdenClient({
      apiKey: "k",
      userId: "u",
      sessionId: "s",
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 200,
      onError: (e) => errors.push(e),
    });
    expect(await eden.observe({ kind: "user_message", text: "hi" })).toEqual({ injection: null, pending: false });
    expect(await eden.ask("x")).toBeNull();
    expect(await eden.pending()).toEqual([]);
    expect(errors.length).toBe(3);
  });

  test("sends the user and session with each event", async () => {
    let sent: any;
    const fake = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ injection: null, pending: false });
    }) as unknown as typeof fetch;
    const eden = new EdenClient({ apiKey: "k", userId: "u", sessionId: "s", fetch: fake });
    await eden.observe({ kind: "external", source: "gmail", text: "New mail" });
    expect(sent).toMatchObject({ userId: "u", sessionId: "s", kind: "external", source: "gmail" });
  });
});

describe("withContext", () => {
  test("puts context right before the latest user message and leaves the prefix alone", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = withContext(messages, [inj("<context>x</context>")]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(out.slice(0, 3)).toEqual(messages.slice(0, 3));
    expect(withContext(messages, [])).toBe(messages);
  });
});
