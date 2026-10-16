/**
 * P4.2: BM25F's fields and score (D17, A2 §2.2, `memory-bm25f.ts`).
 */
import { describe, expect, test } from "bun:test";
import type { MemoryRecord } from "./index";
import { cueTerms, idf, rankable, rowFields, rowTerms, termScore, UNTYPED_NEEDLES, type Corpus } from "./memory-bm25f";

function row(text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id: "r", text, kind: "fact", at: 0, ...extra };
}

/** A corpus of `n` rows, every field of mean length `mean`, and the given dfs (1 for any other term). */
function corpus(n: number, mean: number, dfs: Record<string, number> = {}): Corpus {
  return { n, avg: { value: mean, subject: mean, alias: mean, body: mean }, df: (term) => dfs[term] ?? 1 };
}

describe("rowFields", () => {
  test("the body is the text's needles, stemmed, repeats kept", () => {
    expect(rowFields(row("The queues of the queue service")).body).toEqual(["queue", "queue", "service"]);
  });

  test("a row's aliases are its tags' alias words its text does not hold; `pin`, `howto` and `src:` are none", () => {
    const fields = rowFields(row("We push jobs to SQS.", { tags: ["src:user", "dlq", "sqs", "pin", "howto"] }));
    expect([...fields.alias].sort()).toEqual(["dlq"]);
  });

  test("its D7 keys give the value and subject fields", () => {
    const fields = rowFields(row("We use pnpm here.", { slots: [{ k: "pkg.manager", v: "pnpm" }] }));
    expect(fields.value).toEqual(["pnpm"]);
    expect(fields.subject).toEqual(["package", "manager"]);
    expect([...rowTerms(fields)].sort()).toEqual(["manager", "package", "pnpm"]);
  });

  test("a mined row's folder words are not its needles (where it is true is not what it is about)", () => {
    const mined = row("apps/web uses node 22.", { scope: "apps/web", cite: ["apps/web/.nvmrc"], tags: ["src:tool"] });
    expect(rowFields(mined).body).toEqual(["node"]);
  });
});

describe("rankable", () => {
  const long = Array.from({ length: UNTYPED_NEEDLES + 3 }, (_, i) => `word${"abcdefghijklmnop"[i]}x`).join(" ");

  test("a tool result of more than 12 distinct needles does not rank (P0.6's cost, kept for untyped rows)", () => {
    const tool = row(long, { tags: ["src:tool"] });
    expect(rankable(tool)).toBe(false);
  });

  test("the check reads a tool result only to its 13th distinct term (the soak's Submit grew with the session)", () => {
    const huge = row(`${long} ${"stack frame at module.fn (file.ts:12:3) ".repeat(100_000)}`, { tags: ["src:tool"] });
    const started = performance.now();
    expect(rankable(huge)).toBe(false);
    // Read whole (755402fb2) it took 318 ms here; read to its 13th term, well under 1 ms.
    expect(performance.now() - started).toBeLessThan(25);
  });

  test("a row the user typed ranks at any length (A2 §2.2: the cut is for episodes only)", () => {
    const typed = row(long, { tags: ["src:user"] });
    expect(rankable(typed)).toBe(true);
  });
});

describe("termScore", () => {
  const c = corpus(1_000, 6, { billing: 300, database: 60 });

  test("a short row stating a term outranks a long one naming it once (length normalization, b = 0.75)", () => {
    const short = rowFields(row("Our billing database runs on CockroachDB."));
    const long = rowFields(
      row("Spent the afternoon reading billing database logs with the oncall about retries, timeouts and alerts."),
    );
    expect(termScore("database", short, c)).toBeGreaterThan(termScore("database", long, c));
  });

  test("a rarer term weighs more (IDF)", () => {
    const fields = rowFields(row("billing database"));
    expect(termScore("database", fields, c)).toBeGreaterThan(termScore("billing", fields, c));
    expect(idf(c, "database")).toBeGreaterThan(idf(c, "billing"));
  });

  test("a term in the value field weighs ×3 against the body's ×1 (D17)", () => {
    const keyed = rowFields(row("We use pnpm.", { slots: [{ k: "pkg.manager", v: "pnpm" }] }));
    const said = rowFields(row("We use pnpm."));
    expect(termScore("pnpm", keyed, c)).toBeGreaterThan(termScore("pnpm", said, c));
  });

  test("frequency saturates (k1 = 1.2): saying a term twice is not twice the score", () => {
    const once = rowFields(row("queue alpha beta"));
    const twice = rowFields(row("queue queue beta"));
    const ratio = termScore("queue", twice, c) / termScore("queue", once, c);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(2);
  });

  test("a term the row lacks scores nothing; IDF is never negative", () => {
    expect(termScore("redis", rowFields(row("We use postgres.")), c)).toBe(0);
    expect(idf(corpus(10, 4, { the: 10 }), "the")).toBeGreaterThan(0);
  });
});

describe("R1's tokenizer (lex.ts)", () => {
  test("a cue's tokens as rows are indexed: plurals stemmed, stop words and 1-letter tokens left out, `db` kept", () => {
    expect([...cueTerms(["the", "queues", "db", "pages", "api.ts", "x", "42"])]).toEqual([
      "queue",
      "db",
      "page",
      "api.ts",
    ]);
  });

  test("a row gives a compound identifier whole, its dotted segments and its parts; numbers of 3+ digits count", () => {
    expect(rowFields(row("Moved ticket T-1264 into apps/web/middleware.ts on day 443.")).body).toEqual([
      "moved",
      "ticket",
      "t-1264",
      "1264",
      "apps/web/middleware.ts",
      "middleware.ts",
      "app",
      "web",
      "middleware",
      "ts",
      "day",
      "443",
    ]);
  });

  test("a prompt keeps a dotted name whole, without its parts (P4.1)", async () => {
    const { promptTerms } = await import("./memory-bm25f");
    expect([...promptTerms("who created the Node.js runtime?")]).toEqual(["created", "node.js", "runtime"]);
  });
});
