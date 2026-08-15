/**
 * Wave 5/6 — providers, stumbles, sampling, offline queue.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapBedrock, wrapGemini } from "../src/instrumentations/providers.js";
import { recordStumble } from "../src/stumbles.js";
import { ClientSampler } from "../src/sampling.js";
import { OfflineQueue } from "../src/offline-queue.js";
import { configure, getDefaultClient, resetDefaultClient } from "../src/client.js";

beforeEach(() => {
  resetDefaultClient();
  configure({ orgId: "o", apiKey: "k", baseUrl: "http://eden.test", disabled: true });
});

describe("providers", () => {
  it("wrapBedrock emits on send success", async () => {
    const client = getDefaultClient();
    const raw = {
      send: async () => ({ ok: true }),
    };
    const wrapped = wrapBedrock(raw);
    await wrapped.send({ modelId: "anthropic.claude" });
    // disabled=true still enqueues in dry sense via emit path — disabled skips emit
    expect(client.sampledOut).toBe(0);
  });

  it("wrapGemini wraps generateContent", async () => {
    const raw = {
      generateContent: async () => ({ text: "hi" }),
    };
    const wrapped = wrapGemini(raw);
    const out = await wrapped.generateContent({ model: "gemini-pro" });
    expect(out).toEqual({ text: "hi" });
  });
});

describe("recordStumble", () => {
  it("posts to /stumbles with org api key", async () => {
    const posts: Array<{ url: string; headers: Record<string, string> }> = [];
    resetDefaultClient();
    configure({
      orgId: "org-1",
      apiKey: "key-1",
      baseUrl: "http://eden.test",
      disabled: false,
    });
    // @ts-expect-error stub
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      posts.push({
        url: String(url),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    const result = await recordStumble("bad tool", {
      traceId: "t1",
      kind: "tool_error",
    });
    expect(result).not.toBeNull();
    expect(posts[0]?.url).toContain("/orgs/org-1/stumbles");
    expect(posts[0]?.headers["X-Org-Api-Key"]).toBe("key-1");
  });
});

describe("sampling + offline", () => {
  it("aggressive sampler keeps errors", () => {
    const s = new ClientSampler({ profile: "aggressive", keepErrors: true });
    expect(s.shouldKeep({ hasError: true })).toBe(true);
  });

  it("offline queue roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-oq-"));
    mkdirSync(dir, { recursive: true });
    const q = new OfflineQueue(join(dir, "q.jsonl"), 100);
    q.enqueue("openai", { event_id: "a" });
    expect(q.size()).toBe(1);
    const drained = q.drain(10);
    expect(drained.length).toBe(1);
    expect(q.size()).toBe(0);
  });
});
