import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diagnoseHonesty, type StretchTrace } from "@eden/ir";
import { collectExplain, explainCli, explainHelp, servingLine } from "./explain";
import { writeConfig } from "./home";

function trace(id: string, names: string[], input: Record<string, unknown> = {}): StretchTrace {
  return {
    id,
    llmCalls: names.length,
    duration_ms: 1,
    cost_cents: 0,
    input,
    complete: true,
    events: names.map((name) => ({ name, args: input, result: { ok: true }, ok: true })),
  };
}

describe("eden explain", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-explain-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("help names the letter", () => {
    expect(explainHelp()).toMatch(/why nothing compiled/);
  });

  test("empty home prints 0 stretches and exits 0", async () => {
    const { letter, findings } = await collectExplain({
      fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
    });
    expect(findings[0]!.code).toBe("nothing_recorded");
    expect(letter).toMatch(/Nothing recorded/);
    expect(letter).toMatch(/0 stretches/);
    expect(await explainCli([], { fetch: (async () => new Response("no", { status: 503 })) as typeof fetch })).toBe(0);
  });

  test("micro traces print Too short · 16 stretches of 2 calls (need 3)", async () => {
    const traces = Array.from({ length: 16 }, (_, i) => trace(`m${i}`, ["lookup", "reply"], { id: "T1" }));
    const { letter } = await collectExplain({ traces });
    expect(letter).toMatch(/Too short · 16 stretches of 2 calls \(need 3\)/);
    expect(letter).toMatch(/Wrap a stretch of at least three steps/);
  });

  test("corrupt jsonl line is skipped; letter still prints", async () => {
    writeFileSync(join(home, "runs", "s.jsonl"), "not-json\n{\"name\":\"lookup\",\"args\":{\"id\":1},\"ok\":true}\n{\"name\":\"reply\",\"args\":{},\"ok\":true}\n");
    const { letter } = await collectExplain({
      fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
    });
    expect(letter.length).toBeGreaterThan(10);
    expect(diagnoseHonesty).toBeTypeOf("function");
  });

  test("unique-work traces print Unique work and the count", async () => {
    const traces = Array.from({ length: 12 }, (_, i) => trace(`u${i}`, ["alpha", "beta", `uniq${i}`], { id: `id${i}` }));
    const { letter } = await collectExplain({ traces });
    expect(letter).toMatch(/Unique work · 12 distinct sequences in 12 stretches/);
    expect(letter).toMatch(/Nothing was lost/);
  });

  test("width-split traces print 2 of 3 at width 10", async () => {
    const wide = (id: string, n: number) =>
      trace(id, ["findOrder", ...Array.from({ length: n }, () => "lineItem"), "refund"], { order: id });
    const traces = [wide("a", 7), wide("b", 7), wide("c", 7), wide("d", 10), wide("e", 10)];
    const { letter } = await collectExplain({ traces });
    expect(letter).toMatch(/Width split · 2 of 3 same-shape at width 10/);
  });

  test("envelope-gap traces print novel ids and the need-3 count", async () => {
    const traces = Array.from({ length: 4 }, (_, i) => trace(`h${i}`, ["lookup", "fetch", "reply"], { id: `novel-${i}` }));
    const { letter } = await collectExplain({ traces });
    expect(letter).toMatch(/Envelope gap · 4 novel ids, 0 repeats \(need 3 of the same id\)/);
  });

  test("knock.json is named without inventing a compile", async () => {
    writeFileSync(join(home, "knock.json"), JSON.stringify({ tool_id: "desk_close" }));
    const { letter } = await collectExplain({
      fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
    });
    expect(letter).toMatch(/Nothing recorded/);
    expect(letter).toMatch(/knock waiting · eden open or eden approve/);
    expect(letter).not.toMatch(/Nothing compiled/);
  });

  test("serving line uses Canary and Zero-LLM only when those flags exist", () => {
    expect(servingLine([])).toBe("");
    expect(servingLine([{ rollout: "live" }])).toBe("1 Live");
    expect(
      servingLine([
        { rollout: "canary", program: { steps: [] } as never },
        { program: { steps: [{ kind: "island", pinned: false }] } as never },
      ]),
    ).toBe("1 Canary · 1 Live · 1 Zero-LLM");
    expect(servingLine([{ rollout: "canary", program: { steps: [] } as never }])).toBe("1 Canary · 1 Zero-LLM");
  });
});
