/**
 * Recorded provider window: independently labeled classes vs parseUsage.
 * Cache excluded. Mismatch and wrong class labels fail closed. Not cert-rate.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addTokenClass, billedTokens, emptyTokenClasses, reconcileTokenClasses } from "@eden/ir";
import { parseCacheTokens, parseUsage } from "@eden/wrap";
import {
  attributionAgrees,
  classesForTurn,
  loadProviderWindow,
  PROVIDER_WINDOW_PATH,
  reconcileProviderWindow,
  usageOf,
  type ProviderTurn,
} from "./provider-window";

describe("recorded provider window", () => {
  test("JSON fixture is on disk and a critic can open it", () => {
    expect(existsSync(PROVIDER_WINDOW_PATH)).toBe(true);
    const raw = readFileSync(PROVIDER_WINDOW_PATH, "utf8");
    expect(raw).toContain("prompt_tokens");
    expect(raw).toContain("prompt_tokens_details");
    expect(raw).toContain("cached_tokens");
    expect(raw).toContain("cache_read_input_tokens");
    expect(raw).toContain("input_tokens");
    expect(raw).toContain('"compiled": 2306');
    expect(raw).toContain('"frontier": 178');
    expect(raw).toContain('"transparent": 100');
    expect(raw).not.toContain("assumeProviderUsage");
    expect(raw).not.toMatch(/certRate\s*[>=]|cert-rate\.ts/);
  });

  test("this fixture is not a campaign world and does not retune cert-rate", () => {
    const window = loadProviderWindow();
    expect(window.purpose).toMatch(/not a campaign world/i);
    expect(window.purpose).toMatch(/not a retune of cert-rate/i);
    const cert = readFileSync(join(import.meta.dir, "cert-rate.ts"), "utf8");
    expect(cert).not.toContain("provider-window");
  });

  test("both dialects are present: OpenAI cache subset + Anthropic cache_read", () => {
    const window = loadProviderWindow();
    const openai = window.turns.find((t) => t.provider === "openai" && t.tokenClass === "compiled");
    const anthropic = window.turns.find((t) => t.provider === "anthropic");
    expect(openai).toBeTruthy();
    expect(anthropic).toBeTruthy();

    const oai = parseUsage(usageOf(openai!));
    const oaiCache = parseCacheTokens(usageOf(openai!));
    expect(oai).toEqual({ prompt: 2006, completion: 300 });
    expect(oaiCache?.cached).toBe(1920);
    expect(oaiCache!.cached).toBeLessThan(oai!.prompt);
    expect(oai!.prompt + oai!.completion).toBe(2306);

    const ant = parseUsage(usageOf(anthropic!));
    const antCache = parseCacheTokens(usageOf(anthropic!));
    expect(ant).toEqual({ prompt: 50, completion: 128 });
    expect(antCache?.cached).toBe(100_000);
    expect(ant!.prompt + ant!.completion).toBe(178);
    expect(ant!.prompt + (antCache?.cached ?? 0)).not.toBe(ant!.prompt);
  });

  test("labeled classes are independent of parseUsage — dumping into tokenClass fails", () => {
    const window = loadProviderWindow();
    const turn = window.turns.find((t) => t.id === "openai-compiled-island")!;
    const parsed = parseUsage(usageOf(turn))!;
    const labeled = classesForTurn(turn)!;

    expect(labeled.compiled).toBe(2306);
    expect(labeled.frontier).toBe(0);
    expect(billedTokens(labeled)).toBe(parsed.prompt + parsed.completion);

    // Tautological dump: parseUsage total into whatever tokenClass says.
    const dumped = emptyTokenClasses();
    addTokenClass(dumped, "frontier", parsed.prompt + parsed.completion);
    expect(reconcileTokenClasses(dumped, parsed).ok).toBe(true);
    expect(dumped).not.toEqual(labeled);
    expect(dumped.frontier).toBe(2306);
    expect(labeled.frontier).toBe(0);

    // classesForTurn reads JSON labels — flipping tokenClass must not move the buckets.
    const relabeled: ProviderTurn = { ...turn, tokenClass: "frontier" };
    expect(classesForTurn(relabeled)).toEqual(labeled);
    expect(attributionAgrees(relabeled)).toBe(false);
    expect(attributionAgrees(turn)).toBe(true);

    // Independently labeled tokens sitting in the wrong class fail even when the sum matches.
    const mislabeled: ProviderTurn = {
      ...turn,
      tokenClass: "compiled",
      tokenClasses: { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 2306, providerCache: 1920 },
    };
    expect(reconcileTokenClasses(mislabeled.tokenClasses!, parsed).ok).toBe(true);
    expect(attributionAgrees(mislabeled)).toBe(false);
  });

  test("every measured turn's labeled classes sum to parseUsage; cache excluded; unmeasured omits classes", () => {
    const window = loadProviderWindow();
    expect(window.turns.map((t) => t.tokenClass).sort()).toEqual(
      ["compiled", "frontier", "memoized", "steered-skip", "transparent"].sort(),
    );
    for (const turn of window.turns) {
      const parsed = parseUsage(usageOf(turn));
      const labeled = classesForTurn(turn);
      if (!parsed) {
        expect(labeled).toBeNull();
        expect(turn.tokenClasses).toBeUndefined();
        continue;
      }
      expect(labeled).toBeTruthy();
      expect(attributionAgrees(turn)).toBe(true);
      const recon = reconcileTokenClasses(labeled!, parsed);
      expect(recon.ok).toBe(true);
      expect(recon.delta).toBe(0);
      const cache = parseCacheTokens(usageOf(turn))?.cached ?? 0;
      expect(labeled!.providerCache ?? 0).toBe(cache);
      if (cache > 0) {
        expect(billedTokens(labeled!)).not.toBe(billedTokens(labeled!) + cache);
      }
    }
  });

  test("window rollup: billed vs prompt+completion delta 0; cache is a subset line", () => {
    const recon = reconcileProviderWindow();
    expect(recon.ok).toBe(true);
    expect(recon.attribution).toBe(true);
    expect(recon.rollupAgrees).toBe(true);
    expect(recon.delta).toBe(0);
    expect(recon.billed).toBe(recon.provider);
    expect(recon.billed).toBe(recon.prompt + recon.completion);
    expect(recon.billed).toBe(2584);
    expect(recon.prompt).toBe(2006 + 50 + 80);
    expect(recon.completion).toBe(300 + 128 + 20);
    expect(recon.classes).toEqual({
      compiled: 2306,
      memoized: 0,
      transparent: 100,
      steeredSkip: 0,
      frontier: 178,
      providerCache: 1920 + 100_000,
    });
    expect(recon.providerCache).toBe(101_920);
    expect(recon.billed).not.toBe(recon.billed + recon.providerCache);
  });

  test("unmeasured steered-skip / memoized omit tokenClasses — never invent frontier", () => {
    const window = loadProviderWindow();
    for (const id of ["openai-memoized-hit", "steered-skip-remainder"]) {
      const turn = window.turns.find((t) => t.id === id)!;
      expect(usageOf(turn)).toBeUndefined();
      expect(classesForTurn(turn)).toBeNull();
      expect(turn.tokenClasses).toBeUndefined();
      expect(attributionAgrees(turn)).toBe(true);
    }
  });

  test("mismatch fails closed", () => {
    const recon = reconcileProviderWindow();
    const broken = { ...recon.classes, compiled: recon.classes.compiled + 1 };
    const fail = reconcileTokenClasses(broken, { prompt: recon.prompt, completion: recon.completion });
    expect(fail.ok).toBe(false);
    expect(fail.delta).toBe(1);
  });
});
