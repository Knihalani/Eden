/**
 * Ledger vs a recorded provider window: billed classes === prompt+completion.
 * Cache is a separate line and must not enter the five classes.
 */
import { describe, expect, test } from "bun:test";
import { billedTokens, IslandReply, providerCacheHitPct, reconcileTokenClasses } from "@eden/ir";
import { createTicketShip, ticketShipProgram } from "../../runtime/src/ticketship";
import { createState, wrapTools } from "./index";
import { recordCompletion } from "./usage";

const liveManifest = {
  llmReduction: 8,
  latencyReduction: 8,
  costReduction: 8,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
};

describe("reconciliation: billed classes vs provider window", () => {
  test("agent scrape + island scrape sum to prompt+completion; cache excluded", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = { ...ticketShipProgram(), manifest: liveManifest };
    const island = async (p: Parameters<typeof world.island>[0]) =>
      new IslandReply(await world.island(p), {
        prompt_tokens: 80,
        completion_tokens: 20,
        cached_tokens: 5,
      });
    const state = createState({ programs: [program], island });
    recordCompletion(state.run, {
      usage: {
        prompt_tokens: 40,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    });
    const tools = wrapTools(world.tools, state);
    await tools[program.name]!.execute({ id: "T-100" });
    await tools.notify.execute({ id: "T-100" });

    const rec = state.receipts[0]!;
    expect(rec.prompt_tokens).toBe(80);
    expect(rec.completion_tokens).toBe(20);
    expect(rec.cached_tokens).toBe(5);
    expect(rec.tokenClass).toBe("compiled");
    expect(rec.certified).toBe(true);
    expect(rec.tokenClasses).toEqual({
      compiled: 100,
      memoized: 0,
      transparent: 0,
      steeredSkip: 0,
      frontier: 0,
      providerCache: 5,
    });

    const t = state.traces.at(-1);
    expect(t).toBeTruthy();
    expect(t!.prompt_tokens).toBe(40 + 80);
    expect(t!.completion_tokens).toBe(10 + 20);
    expect(t!.cached_tokens).toBe(8 + 5);
    const classes = t!.tokenClasses!;
    expect(classes.frontier).toBe(50);
    expect(classes.compiled).toBe(100);
    expect(billedTokens(classes)).toBe(t!.prompt_tokens! + t!.completion_tokens!);
    expect(
      reconcileTokenClasses(classes, { prompt: t!.prompt_tokens!, completion: t!.completion_tokens! }).ok,
    ).toBe(true);
    expect(classes.providerCache).toBe(13);
    expect(billedTokens(classes)).not.toBe(billedTokens(classes) + (classes.providerCache ?? 0));
  });

  test("recorded provider window on disk: classes sum to prompt+completion; cache excluded", async () => {
    const { reconcileProviderWindow } = await import("../../../benchmarks/campaign/provider-window");
    const recon = reconcileProviderWindow();
    expect(recon.ok).toBe(true);
    expect(recon.attribution).toBe(true);
    expect(recon.rollupAgrees).toBe(true);
    expect(recon.delta).toBe(0);
    expect(recon.billed).toBe(2584);
    expect(recon.billed).toBe(recon.prompt + recon.completion);
    expect(recon.providerCache).toBeGreaterThan(0);
    expect(recon.billed).not.toBe(recon.billed + recon.providerCache);
  });

  test("steered-skip path omits tokenClasses when unmeasured — never invent frontier", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = { ...ticketShipProgram(), manifest: liveManifest };
    const state = createState({ programs: [program], island: world.island });
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-101" });
    const second = await tools.fetchDetails.execute({ id: "T-101" });
    expect(second).toEqual({ eden: "steered", skipped: "fetchDetails" });

    expect(state.receipts.length).toBeGreaterThan(0);
    for (const rec of state.receipts) {
      if (!rec.ok) continue;
      const measured = rec.prompt_tokens != null && rec.completion_tokens != null;
      if (!measured) {
        expect(rec.tokenClasses).toBeUndefined();
        continue;
      }
      expect(rec.tokenClasses).toBeTruthy();
      expect(reconcileTokenClasses(rec.tokenClasses!, { prompt: rec.prompt_tokens!, completion: rec.completion_tokens! }).ok).toBe(true);
    }
    const skipped = state.receipts.find((r) => r.skipped?.includes("fetchDetails"));
    expect(skipped).toBeTruthy();
    if (skipped?.prompt_tokens == null) expect(skipped!.tokenClasses).toBeUndefined();
  });

  test("wrap receipt copies stamped cache write+denom; digest is 40% not 80%", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = { ...ticketShipProgram(), manifest: liveManifest };
    const island = async (p: Parameters<typeof world.island>[0]) =>
      new IslandReply(await world.island(p), {
        prompt_tokens: 50,
        completion_tokens: 8,
        cached_tokens: 40,
        cache_write_tokens: 10,
        cache_input_tokens: 100,
      });
    const state = createState({ programs: [program], island });
    const tools = wrapTools(world.tools, state);
    await tools[program.name]!.execute({ id: "T-100" });
    const rec = state.receipts[0]!;
    expect(rec.prompt_tokens).toBe(50);
    expect(rec.cached_tokens).toBe(40);
    expect(rec.cache_write_tokens).toBe(10);
    expect(rec.cache_input_tokens).toBe(100);
    expect(rec.tokenClasses?.providerCache).toBe(40);
    expect(providerCacheHitPct(rec.cached_tokens, rec.prompt_tokens, rec.cache_write_tokens, rec.cache_input_tokens)).toBe(0.4);
    expect(providerCacheHitPct(rec.cached_tokens, rec.prompt_tokens)).toBe(0.8);
  });
});
