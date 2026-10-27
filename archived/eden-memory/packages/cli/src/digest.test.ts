import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_DIGEST, renderDigestText } from "@eden/measure";
import {
  cacheHitPctFromReceipts,
  digestCli,
  digestFromInbox,
  digestHelp,
  digestOptedIn,
  type InboxSlice,
} from "./digest";
import { writeConfig } from "./home";

const EMPTY_TEXT = `Eden weekly
0 programs
Compiled runs 0
Waiting 0
Failed 0
Deterministic share —
Tokens saved 0
Last 7 days Mon 0 · Tue 0 · Wed 0 · Thu 0 · Fri 0 · Sat 0 · Sun 0
Needs attention 0`;

describe("eden digest", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;
  const prevDigest = process.env.EDEN_DIGEST;
  const prevKey = process.env.EDEN_API_KEY;
  const prevDev = process.env.EDEN_DEV;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-digest-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    delete process.env.EDEN_DIGEST;
    delete process.env.EDEN_API_KEY;
    delete process.env.EDEN_DEV;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevDigest === undefined) delete process.env.EDEN_DIGEST;
    else process.env.EDEN_DIGEST = prevDigest;
    if (prevKey === undefined) delete process.env.EDEN_API_KEY;
    else process.env.EDEN_API_KEY = prevKey;
    if (prevDev === undefined) delete process.env.EDEN_DEV;
    else process.env.EDEN_DEV = prevDev;
    rmSync(home, { recursive: true, force: true });
  });

  test("default off prints one line and exits 0", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      expect(digestOptedIn(null)).toBe(false);
      expect(await digestCli([])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toBe("digest is off");
  });

  test("EDEN_DIGEST=1 empty fetch is honest zeros", async () => {
    process.env.EDEN_DIGEST = "1";
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:1" });
    let stdout = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(
        await digestCli([], {
          fetch: (async () => {
            throw new Error("plane down");
          }) as unknown as typeof fetch,
        }),
      ).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(stdout.trim()).toBe(EMPTY_TEXT);
    expect(renderDigestText(EMPTY_DIGEST)).toBe(EMPTY_TEXT);
  });

  test("config digest:true enables without EDEN_DIGEST", async () => {
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:1", digest: true });
    expect(digestOptedIn()).toBe(true);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      expect(await digestCli(["--help"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain("Never sends mail");
  });

  test("help lists html and out", () => {
    expect(digestHelp()).toContain("eden digest --html");
    expect(digestHelp()).toContain("eden digest --out file");
    expect(digestHelp()).toContain("EDEN_DIGEST=1");
  });

  test("fake inbox+receipts mapper matches Home tiles", () => {
    const now = Date.UTC(2026, 7, 27, 12);
    const inbox: InboxSlice = {
      candidates: [
        { id: "cand_pending", program: { name: "seed" }, verdict: "pending", created_at: 9 },
        { id: "req_1", program: { name: "bind loop", origin: { mode: "loop" } }, verdict: "pending", created_at: 20 },
      ],
      live: [
        { id: "live_notify", name: "seed", state: "live", stats: { n: 96, fail: 2 }, updated_at: 8 },
        { id: "wf_1", name: "notify", state: "live", stats: { n: 4, fail: 0 }, updated_at: 30 },
        { id: "wf_paused", name: "paused", state: "paused", stats: { n: 2, fail: 1 }, updated_at: 31 },
      ],
      savings: { tokensSavedMean: 12.4, runs: 100, live: 2 } as InboxSlice["savings"],
    };
    const receipts = [
      {
        tool_id: "wf_1",
        created_at: now,
        ok: 1,
        tokenClass: "transparent",
        tokenClasses: { compiled: 6, memoized: 0, transparent: 2, steeredSkip: 4, frontier: 8 },
      },
      {
        tool_id: "wf_1",
        created_at: now + 1,
        ok: 1,
        tokenClass: "steered-skip",
        skipped: ["Grep"],
      },
    ];
    const input = digestFromInbox(inbox, receipts, now);
    expect(input.compiled).toBe(1);
    expect(input.runs).toBe(4);
    expect(input.waiting).toBe(1);
    expect(input.fails).toBe(0);
    expect(input.tokensSaved).toBe(12);
    expect(input.dcPct).toBe(60);
    expect(input.novelty).toEqual([{ name: "bind loop", status: "Loop" }]);
    expect(input.stretches?.some((s) => s.words.includes("Served") && s.words.includes("Skipped"))).toBe(true);
    const text = renderDigestText(input)!;
    expect(text).toContain("1 programs");
    expect(text).toContain("Compiled runs 4");
    expect(text).toContain("Waiting 1");
    expect(text).toContain("Failed 0");
    expect(text).toContain("Deterministic share 60%");
    expect(text).toContain("Tokens saved 12");
    expect(text).toContain("bind loop · Loop");
  });

  test("compose origin uses Compose, the same way as Handoff", () => {
    const input = digestFromInbox({
      candidates: [
        { id: "req_h", program: { name: "pass", origin: { mode: "handoff" } }, verdict: "pending", created_at: 1 },
        { id: "req_c", program: { name: "join", origin: { mode: "compose" } }, verdict: "pending", created_at: 2 },
      ],
    });
    expect(input.novelty).toEqual(
      expect.arrayContaining([
        { name: "pass", status: "Handoff" },
        { name: "join", status: "Compose" },
      ]),
    );
    expect(input.novelty?.some((n) => n.status === "compose")).toBe(false);
  });

  test("canary inbox stretch is Canary · Served, not Live · Served", () => {
    const now = Date.UTC(2026, 7, 27, 12);
    const input = digestFromInbox(
      {
        live: [
          {
            id: "wf_canary",
            name: "notify",
            state: "live",
            rollout: "canary",
            stats: { n: 1, fail: 0 },
            updated_at: 1,
          },
        ],
      },
      [{ tool_id: "wf_canary", created_at: now, ok: 1, tokenClass: "transparent" }],
      now,
    );
    expect(input.stretches?.[0]).toMatchObject({ name: "notify", state: "live", rollout: "canary", words: ["Served"] });
    expect(input.canary).toBe(1);
    const text = renderDigestText(input)!;
    expect(text).toContain("Canary · Served");
    expect(text).not.toContain("Live · Served");
    expect(text).toContain("1 programs · 1 Canary");
    expect(text).not.toContain("Live tools");
  });

  test("--html writes HTML; --out writes a file", async () => {
    process.env.EDEN_DIGEST = "1";
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:1" });
    const out = join(home, "letter.html");
    expect(
      await digestCli(["--html", "--out", out], {
        fetch: (async () => {
          throw new Error("down");
        }) as unknown as typeof fetch,
      }),
    ).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("<h1>Eden weekly</h1>");
    expect(html).toContain("Needs attention 0");
    expect(html).toContain("<h2>Stretches</h2>");
    expect((html.match(/Programs/g) ?? []).length).toBe(1);
    expect(html).toContain(">0<");
  });

  test("provider cache hit % is cached/prompt; DC% ignores providerCache 800; run-cache line stays distinct", () => {
    const now = Date.UTC(2026, 7, 27, 12);
    const inbox: InboxSlice = {
      live: [{ id: "wf_1", name: "notify", state: "live", stats: { n: 4, fail: 0 }, updated_at: 30 }],
      savings: { tokensSavedMean: 12, runs: 4, live: 1 } as InboxSlice["savings"],
    };
    const classes = { compiled: 6, memoized: 0, transparent: 2, steeredSkip: 4, frontier: 8, providerCache: 800 };
    const withoutCache = digestFromInbox(
      inbox,
      [
        {
          tool_id: "wf_1",
          created_at: now,
          tokenClasses: { compiled: 6, memoized: 0, transparent: 2, steeredSkip: 4, frontier: 8 },
        },
      ],
      now,
    );
    const withCache = digestFromInbox(
      inbox,
      [
        {
          tool_id: "wf_1",
          created_at: now,
          prompt_tokens: 2006,
          cached_tokens: 1920,
          tokenClasses: classes,
        },
      ],
      now,
    );
    expect(withoutCache.dcPct).toBe(60);
    expect(withCache.dcPct).toBe(60);
    expect(withCache.dcPct).toBe(withoutCache.dcPct);
    expect(withCache.cacheHitPct).toBe((1920 / 2006) * 100);
    expect(cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 2006, cached_tokens: 1920 }])).toBe(
      (1920 / 2006) * 100,
    );
    expect(cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 2006 }])).toBeNull();
    expect(cacheHitPctFromReceipts([{ tool_id: "wf_1", cached_tokens: 1920 }])).toBeNull();
    expect(cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 100, cached_tokens: 0 }])).toBe(0);
    expect(
      cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 50, cached_tokens: 40, cache_write_tokens: 10 }]),
    ).toBe(40);
    expect(
      cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 50, cached_tokens: 40, cache_write_tokens: 10 }]),
    ).not.toBe(80);
    expect(
      cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 50, cached_tokens: 100000, cache_write_tokens: 0 }]),
    ).toBe((100_000 / 100_050) * 100);
    expect(
      cacheHitPctFromReceipts([{ tool_id: "wf_1", prompt_tokens: 50, cached_tokens: 100000, cache_write_tokens: 0 }]),
    ).not.toBe((100_000 / 50) * 100);
    expect(
      cacheHitPctFromReceipts([
        { tool_id: "wf_oai", prompt_tokens: 2006, cached_tokens: 1920 },
        { tool_id: "wf_ant", prompt_tokens: 50, cached_tokens: 100000, cache_write_tokens: 0 },
      ]),
    ).toBe((101_920 / 102_056) * 100);
    expect(
      cacheHitPctFromReceipts([
        { tool_id: "wf_oai", prompt_tokens: 2006, cached_tokens: 1920 },
        { tool_id: "wf_ant", prompt_tokens: 50, cached_tokens: 100000, cache_write_tokens: 0 },
      ]),
    ).not.toBe((101_920 / 2136) * 100);
    expect(
      cacheHitPctFromReceipts([
        {
          tool_id: "wf_1",
          prompt_tokens: 50,
          cached_tokens: 40,
          cache_write_tokens: 10,
          cache_input_tokens: 100,
        },
      ]),
    ).toBe(40);
    expect(
      cacheHitPctFromReceipts([
        {
          tool_id: "wf_1",
          prompt_tokens: 50,
          input_tokens: 50,
          cached_tokens: 40,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      ]),
    ).toBe(40);
    const anthropic = digestFromInbox(
      inbox,
      [
        {
          tool_id: "wf_1",
          created_at: now,
          prompt_tokens: 50,
          cached_tokens: 100000,
          cache_write_tokens: 0,
          cache_input_tokens: 100_050,
          tokenClasses: classes,
        },
      ],
      now,
    );
    expect(anthropic.dcPct).toBe(60);
    expect(anthropic.cacheHitPct).toBe((100_000 / 100_050) * 100);
    const anthropicText = renderDigestText(anthropic)!;
    expect(anthropicText).toContain("Deterministic share 60%");
    expect(anthropicText).toContain("provider cache hit % 100%");
    expect(anthropicText).not.toMatch(/200000/);
    expect(anthropicText).not.toMatch(/3 of 4 reads from cache/);
    const text = renderDigestText(withCache)!;
    expect(text).toContain("Deterministic share 60%");
    expect(text).toContain("provider cache hit % 96%");
    expect(text).not.toMatch(/3 of 4 reads from cache/);
    expect(text).not.toMatch(/reads from cache/);
    const unmeasured = digestFromInbox(
      inbox,
      [
        {
          tool_id: "wf_1",
          created_at: now,
          tokenClasses: { compiled: 6, memoized: 0, transparent: 2, steeredSkip: 4, frontier: 8 },
        },
      ],
      now,
    );
    expect(unmeasured.cacheHitPct).toBeNull();
    expect(renderDigestText(unmeasured)!).not.toMatch(/provider cache hit %/);
  });

  test("Needs attention novelty is waste-first; unique-work stays empty", () => {
    const input = digestFromInbox({
      candidates: [
        {
          id: "low",
          program: { name: "cheap" },
          verdict: "FAIL",
          created_at: 90,
          refusal: { code: "unbound_foreach", wastedTokens: 40 },
        },
        {
          id: "high",
          program: { name: "expensive" },
          verdict: "FAIL",
          created_at: 1,
          refusal: { code: "too_short", wastedTokens: 800 },
        },
      ],
    });
    expect(input.novelty.map((n) => [n.name, n.status])).toEqual([
      ["expensive", "Too short"],
      ["cheap", "Unbound loop"],
    ]);
    const passFirst = digestFromInbox({
      candidates: [
        {
          id: "cheap",
          program: { name: "cheap" },
          verdict: "FAIL",
          created_at: 90,
          refusal: { code: "unbound_foreach", wastedTokens: 45 },
        },
        {
          id: "desk",
          program: { name: "getAccount_to_emailCustomer", wastedTokens: 4000 },
          verdict: "PASS",
          created_at: 1,
        },
      ],
    });
    expect(passFirst.novelty.map((n) => [n.name, n.status])).toEqual([
      ["getAccount_to_emailCustomer", "Ready"],
      ["cheap", "Unbound loop"],
    ]);
    expect(digestFromInbox({ candidates: [] }).novelty).toEqual([]);
    expect(
      digestFromInbox({
        candidates: [
          {
            id: "uw",
            program: { name: "noise", origin: { mode: "Unique work" } },
            verdict: "FAIL",
            created_at: 1,
            refusal: { wastedTokens: 9000 },
          },
        ],
      }).novelty,
    ).toEqual([]);
  });
});
