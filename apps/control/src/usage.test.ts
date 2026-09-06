import { describe, expect, test } from "bun:test";
import { createState, recordCompletion } from "@eden/wrap";
import { handleApi } from "./api";
import { Store } from "./store";

describe("trace ingest (20a)", () => {
  test("posted traces inherit scraped chat usage and keep the tool output", async () => {
    const store = new Store(":memory:");
    const wrapState = createState();
    recordCompletion(wrapState.run, {
      usage: { prompt_tokens: 9, completion_tokens: 2 },
      choices: [{ message: { content: "assistant" } }],
    });
    const res = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({
          id: "a",
          events: [{ name: "ping", args: {}, ok: true, result: { ok: true } }],
          output: { ok: true },
          llmCalls: 0,
          duration_ms: 1,
          cost_cents: 0,
        }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(res?.status).toBe(200);
    const stored = store.traces()[0]!;
    expect(stored.prompt_tokens).toBe(9);
    expect(stored.completion_tokens).toBe(2);
    expect(stored.llmCalls).toBe(1);
    expect(stored.output).toEqual({ ok: true });
    expect(wrapState.run.measured).toBe(false);
    expect(wrapState.run.llmCalls).toBe(0);
  });

  test("duplicates of a measured stretch do not burn sitting usage", async () => {
    const store = new Store(":memory:");
    const wrapState = createState();
    const ping = { name: "ping", args: {}, ok: true, result: { ok: true } };
    const first = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({
          id: "dup",
          events: [ping],
          llmCalls: 1,
          prompt_tokens: 99,
          completion_tokens: 9,
          duration_ms: 1,
          cost_cents: 0,
        }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(first?.status).toBe(200);
    recordCompletion(wrapState.run, {
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    });
    const dup = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({
          id: "dup-again",
          events: [ping],
          llmCalls: 0,
          duration_ms: 1,
          cost_cents: 0,
        }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(dup?.status).toBe(200);
    expect((await dup!.json()) as { duplicates: number }).toMatchObject({ duplicates: 1 });
    expect(store.traces()[0]!.prompt_tokens).toBe(99);
    expect(wrapState.run.measured).toBe(true);
    const next = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({
          id: "b",
          events: [{ name: "pong", args: {}, ok: true, result: { ok: true } }],
          llmCalls: 0,
          duration_ms: 1,
          cost_cents: 0,
        }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(next?.status).toBe(200);
    const stored = store.traces().find((t) => t.id === "b")!;
    expect(stored.prompt_tokens).toBe(4);
    expect(stored.completion_tokens).toBe(1);
    expect(wrapState.run.measured).toBe(false);
  });

  test("already-measured ingest does not steal sitting usage", async () => {
    const store = new Store(":memory:");
    const wrapState = createState();
    recordCompletion(wrapState.run, {
      usage: { prompt_tokens: 11, completion_tokens: 2 },
    });
    const res = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({
          id: "measured",
          events: [{ name: "ping", args: {}, ok: true, result: { ok: true } }],
          llmCalls: 1,
          prompt_tokens: 99,
          completion_tokens: 9,
          duration_ms: 1,
          cost_cents: 0,
        }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(res?.status).toBe(200);
    expect(store.traces()[0]!.prompt_tokens).toBe(99);
    expect(wrapState.run.prompt_tokens).toBe(11);
  });

  test("late usage upgrades an already-stored unmeasured stretch", async () => {
    const store = new Store(":memory:");
    const wrapState = createState();
    const ping = { name: "ping", args: { n: 1 }, ok: true, result: { ok: true } };
    const body = {
      id: "late",
      events: [ping],
      llmCalls: 0,
      duration_ms: 1,
      cost_cents: 0,
    };
    const first = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(first?.status).toBe(200);
    expect(store.traces()[0]!.prompt_tokens).toBeUndefined();
    recordCompletion(wrapState.run, {
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const again = await handleApi(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: JSON.stringify({ ...body, id: "late-2" }),
      }),
      new URL("http://x/v1/traces"),
      { store, token: "k", wrapState },
    );
    expect(again?.status).toBe(200);
    expect(store.traces()).toHaveLength(1);
    expect(store.traces()[0]!.prompt_tokens).toBe(5);
    expect(store.traces()[0]!.completion_tokens).toBe(2);
    expect(wrapState.run.measured).toBe(false);
  });
});
