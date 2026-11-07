import { describe, expect, test } from "bun:test";
import { armPromptsHash, systemPrompt, TENANT_GUIDE, worldOf } from "./ab-common";

// `--tenant-prompt` (A3, D271): the tenant's house rules in every arm's system prompt, so every arm's fixed prefix is
// above Anthropic's cache minimum (cache-probe.ts measured the `eden` arm's at about 500 tokens without them).
describe("tenant prompt (D271)", () => {
  const { world } = worldOf(41, "train1", "hidden", { maxTasks: 2, maxOffworld: 0 });

  test("off, the prompt is what every earlier run sent", () => {
    const plain = systemPrompt(world, { lookups: false, data: true });
    expect(plain).not.toContain("House rules");
    expect(systemPrompt(world, { lookups: false, data: true, tenant: false })).toBe(plain);
  });

  test("on, the house rules follow the harness's own prompt, the same in every arm", () => {
    const tools = systemPrompt(world, { lookups: false, data: true, tenant: true });
    const none = systemPrompt(world, { lookups: false, data: false, tenant: true });
    expect(tools).toBe(systemPrompt(world, { lookups: false, data: true }) + TENANT_GUIDE);
    expect(none.endsWith(TENANT_GUIDE)).toBe(true);
    // Long enough to lift a ~500-token prefix past 512 (about 4 characters a token).
    expect(TENANT_GUIDE.length).toBeGreaterThan(1_500);
    // It says nothing about checking the user's data: it must move every arm alike.
    expect(TENANT_GUIDE).not.toMatch(/ask_context|context partner|check (the|every)/i);
  });

  test("a run with it cannot reuse arms from a run without it", () => {
    expect(armPromptsHash({ queryParams: "q", tenant: TENANT_GUIDE })).not.toBe(armPromptsHash({ queryParams: "q" }));
  });
});
