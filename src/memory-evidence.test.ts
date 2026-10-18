/**
 * P4.3: A7 §4's evidence gate on the lexical path (`AgentMemory.relevant`): STRONG admits alone; the MEDIUM path needs
 * the parts' BM25F sum at τ_repo (`memory-tau.ts`) and 0.7 of the MEDIUM path's top score (D17); WEAK never admits; an
 * episode needs MEDIUM from two cue parts. These stores hold filler rows, so idf separates a rare word from a common
 * one as it does in a real store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type MemoryRecord } from "./index";
import { situationCue } from "./memory-cue";
import { resolveFlags } from "./memory-flags";
import { tauGateOn } from "../scripts/test-gate";

tauGateOn();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store of `filler` rows of their own words (df 1 each), plus whatever the test remembers. */
function store(filler = 40) {
  const dir = mkdtempSync(join(tmpdir(), "eden-evidence-"));
  dirs.push(dir);
  const mem = openMemory({ dir });
  mem.quiet(() => {
    for (let i = 0; i < filler; i++)
      mem.remember(`Filler note ${i}: the w${i}a and w${i}b gadgets hold q${i}x values.`, { kind: "fact" });
  });
  return mem;
}

const texts = (rows: readonly MemoryRecord[]) => rows.map((row) => row.text);
const FACT = "The billing service runs on port 8080 behind the gateway.";

describe("A7 §4: the MEDIUM path admits at τ_repo, R1's strict point until a refit is trusted", () => {
  test("one shared rare word does not admit a typed row; three do", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    expect(texts(mem.relevant("what about billing?"))).toEqual([]);
    expect(texts(mem.relevant("which port does the billing service use?"))).toEqual([FACT]);
  });

  test("the gate's trace: τ, the candidates with evidence, their top sum, the rows admitted by class", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    mem.relevant("what about billing?");
    expect(mem.lastGate).toMatchObject({ evidenced: 1, strong: 0, medium: 0 });
    expect(mem.lastGate!.tau).toBeGreaterThan(mem.lastGate!.top);
    mem.relevant("which port does the billing service use?");
    expect(mem.lastGate).toMatchObject({ evidenced: 1, strong: 0, medium: 1 });
    expect(mem.lastGate!.top).toBeGreaterThanOrEqual(mem.lastGate!.tau);
  });

  test("τ scales with the store's mean idf: the same two-word match admits in a store of 5 rows and of 200", () => {
    for (const filler of [4, 199]) {
      const mem = store(filler);
      mem.remember("Invoices are rendered by the ledgerline worker nightly.", { kind: "fact" });
      expect(texts(mem.relevant("how often does the ledgerline worker render invoices?"))).toHaveLength(1);
      expect(mem.relevant("is ledgerline up?")).toEqual([]);
    }
  });

  test("STRONG: an identifier-shaped token the row shares with the prompt admits it alone, below τ", () => {
    const mem = store();
    mem.remember("Deploys read their config from infra/fly.toml.", { kind: "fact" });
    expect(texts(mem.relevant("open infra/fly.toml"))).toHaveLength(1);
    expect(mem.lastGate).toMatchObject({ strong: 1, medium: 0 });
  });

  test("WEAK: words more than 50 visible rows hold never admit, whatever τ is", () => {
    const mem = store(0);
    mem.quiet(() => {
      for (let i = 0; i < 60; i++)
        mem.remember(`Staging deploy number ${i} went out on host h${i}z.`, { kind: "fact" });
    });
    const before = process.env.EDEN_MEMORY_TAU;
    process.env.EDEN_MEMORY_TAU = "0";
    try {
      expect(mem.relevant("staging deploy went out")).toEqual([]);
      expect(mem.lastGate!.evidenced).toBe(0);
    } finally {
      if (before === undefined) delete process.env.EDEN_MEMORY_TAU;
      else process.env.EDEN_MEMORY_TAU = before;
    }
  });
});

describe("P4.3 iteration (dev and R8's silence set): names in prose and one rare word", () => {
  test("one rare word never admits a short row on the MEDIUM path, however high it scores; two do", () => {
    const mem = store();
    const rule = "Prefer Rustacean over Gopherish for new scripts.";
    mem.remember(rule, { kind: "fact" });
    const before = process.env.EDEN_MEMORY_TAU;
    process.env.EDEN_MEMORY_TAU = "0.5";
    try {
      expect(mem.relevant("write a Rustacean function that flattens a nested array")).toEqual([]);
      expect(texts(mem.relevant("which language do we prefer for new scripts, Rustacean?"))).toEqual([rule]);
    } finally {
      if (before === undefined) delete process.env.EDEN_MEMORY_TAU;
      else process.env.EDEN_MEMORY_TAU = before;
    }
  });

  test("two words that share letters are two words; a compound's parts are one (review round 5)", () => {
    for (const [fact, cue] of [
      ["Reporting listens on port 9443.", "reporting port?"],
      ["The login log rotates daily.", "login log?"],
    ]) {
      const mem = store();
      mem.remember(fact!, { kind: "fact" });
      expect(texts(mem.relevant(cue!))).toEqual([fact]);
    }
  });

  test("a capitalized name with an inner capital is a word to the gate, not STRONG; a camelCase symbol is STRONG", () => {
    const mem = store();
    const queue = "The worker consumes BullMQ queues on Redis 7.";
    const strict = "TypeScript runs in strict mode with noUncheckedIndexedAccess enabled.";
    mem.remember(queue, { kind: "fact" });
    mem.remember(strict, { kind: "fact" });
    expect(mem.relevant("what does the Bull in BullMQ refer to?")).toEqual([]);
    expect(mem.relevant("when was TypeScript first released?")).toEqual([]);
    expect(texts(mem.relevant("why is noUncheckedIndexedAccess on?"))).toEqual([strict]);
    expect(mem.lastGate).toMatchObject({ strong: 1 });
  });

  test("a product named like a script (Next.js) is a word to the gate; a lowercase file name is STRONG", () => {
    const mem = store();
    const app = "The web app is Next.js 15 with the App Router.";
    const config = "Image domains are allowed in next.config.js.";
    mem.remember(app, { kind: "fact" });
    mem.remember(config, { kind: "fact" });
    expect(mem.relevant("what does SSR stand for in Next.js?")).toEqual([]);
    expect(texts(mem.relevant("open next.config.js"))).toEqual([config]);
  });

  test("in shadow, the admission before the gate still reads them as identifiers; the trace counts the drop", () => {
    const mem = store();
    mem.remember("The worker consumes BullMQ queues on Redis 7.", { kind: "fact" });
    mem.gateFlag = "shadow";
    expect(mem.relevant("what does the Bull in BullMQ refer to?")).toHaveLength(1);
    expect(mem.lastGate).toMatchObject({ mode: "shadow", strong: 0, medium: 0, drop: 1 });
  });
});

describe("D17's 0.7·top cut, on the MEDIUM path", () => {
  test("a row under 0.7 of the MEDIUM path's top score is left out", () => {
    const mem = store();
    mem.remember("The billing service runs on port 8080 behind the gateway in staging.", { kind: "fact" });
    mem.remember("The gateway logs to stdout.", { kind: "fact" });
    const found = texts(mem.relevant("which port does the billing service in staging use behind the gateway?"));
    expect(found).toEqual(["The billing service runs on port 8080 behind the gateway in staging."]);
  });

  test("a STRONG row is admitted whatever its score and sets no top", () => {
    const mem = store();
    mem.remember("The billing service runs on port 8080 behind the gateway in staging.", { kind: "fact" });
    mem.remember("Billing config lives in services/billing/config.ts.", { kind: "fact" });
    const found = texts(mem.relevant("billing service port staging gateway, see services/billing/config.ts"));
    expect(found).toHaveLength(2);
  });

  test("the prompt typed before and stored sets no top: the fact it asks about is still admitted", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    const prompt = "which port does the billing service use behind the gateway today?";
    mem.remember(prompt, { kind: "episode" });
    expect(texts(mem.relevant(prompt))).toContain(FACT);
  });
});

describe("D26's residual before the cut: a stored copy of the prompt or of the previous typed prompt", () => {
  test("the previous typed prompt, stored as an episode, is never admitted on the context it is part of", () => {
    const mem = store();
    mem.remember("open apps/web/app/login.ts", { kind: "episode", tags: ["src:user"] });
    const cue = situationCue({ turn: "open apps/web/app/login.ts", path: "login.ts web" }, "imperative");
    expect(texts(mem.relevant("fix the redirect there", 6, undefined, cue))).toEqual([]);
  });
});

describe("A7 §4: an episode needs MEDIUM from two cue parts, and τ", () => {
  const tool = (mem: ReturnType<typeof store>, text: string) => mem.remember(text, { tags: ["src:tool"] });

  test("a tool result sharing only the prompt's words is not admitted; with the previous prompt's too, it is", () => {
    const mem = store();
    tool(mem, "checkout flaky retries payments");
    expect(mem.relevant("the checkout payments test is flaky again")).toEqual([]);
    const cue = situationCue({ turn: "look at payments retries" }, "imperative");
    expect(texts(mem.relevant("the checkout payments test is flaky again", 6, undefined, cue))).toHaveLength(1);
  });

  test("a request the user typed is an episode; a statement they typed is a fact (A4 §3.0, P0.2's one-off asks)", () => {
    const mem = store();
    mem.remember("Add a retry to the billing webhook handler.", { kind: "episode" });
    mem.remember("The billing webhook handler retries three times.", { kind: "episode" });
    expect(texts(mem.relevant("how many retries does the billing webhook handler make?"))).toEqual([
      "The billing webhook handler retries three times.",
    ]);
  });
});

describe("`gate.tau` (memory-flags.ts): shadow by default, the gate's admission only when on", () => {
  test("the flag defaults to shadow", () => {
    expect(resolveFlags(undefined, {})["gate.tau"]).toEqual({ mode: "shadow", source: "default" });
  });

  test("shadow admits as before the gate (a word shared with the prompt) and records what the gate would drop", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    mem.gateFlag = "shadow";
    expect(texts(mem.relevant("what about billing?"))).toEqual([FACT]);
    expect(mem.lastGate).toMatchObject({ mode: "shadow", medium: 0, drop: 1 });
  });

  test("shadow leaves a stored copy of the prompt to the delivery's residual, as before, and drops none of it", () => {
    // The world guards (P4.3's measurement): removing it before the cap let one more row into a packet.
    const mem = store();
    const prompt = "which port does the billing service use behind the gateway today?";
    mem.remember(prompt, { kind: "episode" });
    mem.gateFlag = "shadow";
    expect(texts(mem.relevant(prompt))).toEqual([prompt]);
    expect(mem.lastGate).toMatchObject({ mode: "shadow", drop: 0 });
  });

  test("off admits as before the gate and computes nothing", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    mem.gateFlag = "off";
    expect(texts(mem.relevant("what about billing?"))).toEqual([FACT]);
    expect(mem.lastGate).toBeUndefined();
  });

  test("on admits by the gate", () => {
    const mem = store();
    mem.remember(FACT, { kind: "fact" });
    mem.gateFlag = "on";
    expect(mem.relevant("what about billing?")).toEqual([]);
    expect(mem.lastGate).toMatchObject({ mode: "on" });
    expect(mem.lastGate!.drop).toBeUndefined();
  });
});
