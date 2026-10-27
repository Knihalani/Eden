import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledStep } from "./types";
import { buildDag, layers } from "./dag";
import { extractNamedCliCalls, hasUnsafeGhVerb, isMutatingGh } from "./named-cli";
import { planFromBash } from "./plan";
import { modelFacing } from "./compact";
import { compactStdout } from "./fulfill";
import { densifyValue } from "./densify";
import { resolveTemplate } from "./urls";

describe("dag: a write never shares a wave with another write", () => {
  test("data deps onto commuting reads do not waive the sequential edge", () => {
    // [read, write(dep→read), read, write(dep→read)]: each write's data dep
    // pointed at an earlier commuting read, which used to suppress the
    // sequential ordering edge entirely — so both writes landed in the same
    // parallel layer and raced through Promise.all.
    const steps: CompiledStep[] = [
      { id: "r1", kind: "cloud_http", name: "get1", url: "https://x/a", commute: true },
      { id: "w1", kind: "cloud_http", name: "post1", url: "https://x/{{r1.number}}", commute: false },
      { id: "r2", kind: "cloud_http", name: "get2", url: "https://x/b", commute: true },
      { id: "w2", kind: "cloud_http", name: "post2", url: "https://x/{{r2.number}}", commute: false },
    ];
    const dag = buildDag(steps);
    expect(dag.find((n) => n.id === "w2")!.deps).toContain("w1");
    const waves = layers(dag).map((w) => w.map((n) => n.id));
    const layerOf = (id: string) => waves.findIndex((wave) => wave.includes(id));
    const writes = dag.filter((n) => !n.commute).map((n) => n.id);
    for (const w of writes) expect(layerOf(w)).toBeGreaterThan(layerOf("r1"));
    // The two writes themselves must sit in different waves — no Promise.all race.
    expect(new Set(writes.map(layerOf)).size).toBe(writes.length);
  });
});

describe("named cli dedupe respects mutation", () => {
  test("two POSTs differing only in body are two calls", () => {
    // The dedupe key was family+subcommand+first positional+host and ignored
    // flags entirely, so `curl -X POST … -d amount=1` twice collapsed into ONE
    // call — half the writes silently dropped from the mined island. (The
    // reconstruction `curl ${url}` still loses the flags; the point here is
    // that mutating segments are never collapsed.)
    const calls = extractNamedCliCalls(
      "curl -X POST https://api.acme.com/v1/orders -d amount=1 ; curl -X POST " +
        "https://api.acme.com/v1/orders -d amount=2",
    );
    expect(calls.length).toBe(2);
  });

  test("identical GETs are still one call", () => {
    const calls = extractNamedCliCalls("curl https://api.acme.com/v1/orders/1 ; curl https://api.acme.com/v1/orders/1");
    expect(calls.length).toBe(1);
  });

  test("a mutating curl in one segment does not un-dedupe reads in another", () => {
    const calls = extractNamedCliCalls(
      "curl -X POST https://api.acme.com/v1/orders ; curl https://api.acme.com/v1/orders/1 ; curl " +
        "https://api.acme.com/v1/orders/1",
    );
    // The POST plus exactly one copy of the repeated GET.
    expect(calls.length).toBe(2);
  });
});

describe("gh named verbs gate mutations", () => {
  test("mutating named subcommands are recognised", () => {
    for (const cmd of [
      "gh pr close 12",
      "gh pr merge 12 --squash",
      "gh pr edit 12 --title x",
      "gh pr reopen 12",
      "gh pr ready 12",
      "gh pr pin 12",
      "gh issue close 5",
      "gh issue delete 5",
      "gh issue edit 5",
      "gh issue pin 5",
      "gh repo delete o/r",
      "gh repo archive o/r",
      "gh repo edit o/r",
      "gh run cancel 99",
      "gh run rerun 99",
      "gh release delete v1",
    ]) {
      expect(isMutatingGh(cmd)).toBe(true);
    }
  });

  test("read-only named subcommands stay reads", () => {
    for (const cmd of ["gh pr view 12", "gh pr list", "gh issue view 5", "gh run list", "gh release view v1"]) {
      expect(isMutatingGh(cmd)).toBe(false);
    }
  });

  test("verbs that write but carry no -X or -f are still mutating", () => {
    // create/comment/reopen/transfer/unlock/star-style verbs perform writes
    // that the HTTP-verb heuristics can never see, and gh's -b/--body carry a
    // request body exactly like -f does.
    for (const cmd of [
      "gh pr create --title x",
      "gh issue comment 12 --body x",
      "gh issue comment 12 -b x",
      "gh issue reopen 5",
      "gh issue transfer 5 o/other",
      "gh issue unlock 5",
      "gh repo star cli/cli",
      "gh api repos/o/r/issues -b 'body text'",
      "gh api repos/o/r/issues --body 'body text'",
    ]) {
      expect(isMutatingGh(cmd)).toBe(true);
    }
    // Reads are unaffected by the widened lists.
    for (const cmd of ["gh pr view 12", "gh issue view 5", "gh run list"]) {
      expect(isMutatingGh(cmd)).toBe(false);
    }
  });

  test("hasUnsafeGhVerb refuses what it cannot prove read-only", () => {
    for (const cmd of ["gh pr close 12", "gh run list\ngh repo delete o/r", "gh widget frobnicate 1"]) {
      expect(hasUnsafeGhVerb(cmd)).toBe(true);
    }
    for (const cmd of ["gh pr view 12", "for n in 170 169; do gh api repos/o/r/pulls/$n; done", "echo hello"]) {
      expect(hasUnsafeGhVerb(cmd)).toBe(false);
    }
  });

  test("planFromBash refuses a loop carrying an unsafe gh verb", () => {
    const base = "for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n > .raw/pull-$n.json; done";
    expect(planFromBash(base)).not.toBeNull();
    expect(planFromBash(`${base}; gh pr merge 170`)).toBeNull();
    expect(planFromBash(`for n in 170 169; do gh api repos/KaiavN/Eden/pulls/$n; done\ngh repo delete o/r`)).toBeNull();
  });
});

describe("modelFacing truncation is structural, not a size guess", () => {
  test("an array sample marks truncated even when facts serialize smaller", () => {
    // Twelve rows sampled to three: the old flag compared stringify sizes and,
    // because picking facts shrinks almost anything, reported "not truncated"
    // for exactly the results where rows were discarded.
    const value = Array.from({ length: 12 }, (_, i) => ({ title: `row ${i}`, number: i }));
    expect(modelFacing(value).truncated).toBe(true);
  });

  test("a depth-capped result marks truncated", () => {
    // pickFacts descends unconditionally through arrays (the depth<2 gate is
    // object-keys-only), so nesting arrays past the depth cap is what actually
    // reaches the `depth > 4` bail.
    let deep: unknown = { title: "leaf", number: 1 };
    for (let i = 0; i < 8; i++) deep = [deep];
    expect(modelFacing(deep).truncated).toBe(true);
  });

  test("a dropped long string marks truncated", () => {
    const value = { title: "ok", note: "y".repeat(500) };
    expect(modelFacing(value).truncated).toBe(true);
  });

  test("a small fully-represented result is not truncated", () => {
    expect(modelFacing({ title: "fix boot", number: 170 }).truncated).toBe(false);
    expect(modelFacing({ title: "fix boot", number: 170 }).text).not.toContain("full result stored");
  });
});

describe("compactStdout -q scoping", () => {
  // Output over the byte budget is vaulted under EDEN_HOME; unset, that is the real ~/.eden (#67).
  const prevHome = process.env.EDEN_HOME;
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "eden-core-vault-"));
    process.env.EDEN_HOME = home;
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a non-gh command with -q still gets compacted", () => {
    // `pytest -q` matched /\s-q\b/, which early-returned and disabled ALL
    // compaction for any quiet-flagged tool.
    const blob = Array.from({ length: 80 }, (_, i) => `line ${i}: some build output to shrink`).join("\n");
    const r = compactStdout("pytest -q tests/", blob);
    expect(r.stdout.length).toBeLessThan(blob.length);
  });

  test("gh api --jq keeps its already-filtered stdout intact", () => {
    const out = '{"number":170}';
    expect(compactStdout("gh api repos/o/r --jq '{number:.number}'", out).stdout).toBe(out);
  });
});

describe("resolveTemplate path traversal guard", () => {
  test("prototype-chain properties are not bound", () => {
    const s1 = Object.create({ number: 99 });
    expect(resolveTemplate("https://x/s/{{s1.number}}", {}, { s1 })).toBe("https://x/s/");
  });

  test("__proto__/constructor/prototype segments contribute nothing", () => {
    // {{s1.constructor.name}} resolved to "Object" and was spliced into the URL.
    expect(resolveTemplate("https://x/s/{{s1.constructor.name}}", {}, { s1: {} })).toBe("https://x/s/");
    expect(
      resolveTemplate(
        "https://x/s/{{s1.__proto__.polluted}}",
        {},
        JSON.parse('{"s1":{"__proto__":{"polluted":"evil"}}}'),
      ),
    ).toBe("https://x/s/");
    expect(resolveTemplate("https://x/s/{{s1.prototype.x}}", {}, { s1: {} })).toBe("https://x/s/");
  });

  test("own properties still resolve", () => {
    expect(resolveTemplate("{origin}/issues/{{s1.number}}", { origin: "https://x" }, { s1: { number: 12 } })).toBe(
      "https://x/issues/12",
    );
  });
});

describe("densifyValue terminates on cycles and runaway depth", () => {
  test("a cyclic object densifies without blowing the stack", () => {
    const node: Record<string, unknown> = { title: "a", number: 1 };
    node.self = node;
    const out = densifyValue(node) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[CYCLE]");
    // The non-cyclic fields survive.
    expect(out.title).toBe("a");
  });

  test("two objects forming a cycle through each other terminate", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", back: a };
    a.forward = b;
    const out = densifyValue(a) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[CYCLE]");
  });

  test("a deep chain terminates instead of overflowing", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    const out = JSON.stringify(densifyValue(deep));
    expect(out).toContain("[TRUNCATED]");
  });

  test("a value shared between siblings is densified under both parents", () => {
    const shared = { n: 1, title: "same" };
    const root = { left: shared, right: shared };
    const out = densifyValue(root) as Record<string, unknown>;
    expect(out.left).toEqual({ n: 1, title: "same" });
    expect(out.right).toEqual({ n: 1, title: "same" });
    expect(JSON.stringify(out)).not.toContain("[CYCLE]");
  });
});
