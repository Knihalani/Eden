/**
 * M4.4 ranker hygiene. Covers M4.1–M4.3.
 * Report §5.1 leftover: binary IDF (no TF, no length norm) is known; not M4's rewrite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, queryHay } from "./index";
import { pathCues } from "./memory-sota";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/59

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

function withMem(fn: (mem: ReturnType<typeof openMemory>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eden-m44-"));
  try {
    fn(openMemory({ dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function relevantSrc(): string {
  const i = INDEX_SRC.indexOf("relevant(text:");
  const j = INDEX_SRC.indexOf("notesFor(", i);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThan(i);
  return INDEX_SRC.slice(i, j);
}

const LOCOMO_HAY = ["diet", "child", "kid", "dog", "cat", "running", "stained", "adoption"] as const;

describe("M4.1 queryHay", () => {
  test('queryHay("best restaurant") does not contain "diet"', () => {
    expect(queryHay("best restaurant").has("diet")).toBe(false);
  });

  test("restaurant/food/dinner/lunch queries do not inject LoCoMo hay", () => {
    for (const q of ["best restaurant", "food nearby", "dinner tonight", "lunch spot"]) {
      const hay = queryHay(q);
      for (const tok of LOCOMO_HAY) {
        expect(hay.has(tok)).toBe(false);
      }
    }
  });

  test("shoes query does not add running", () => {
    expect(queryHay("what shoes should I buy").has("running")).toBe(false);
  });

  test("pet query does not add dog or cat", () => {
    const hay = queryHay("tell me about my pet");
    expect(hay.has("dog")).toBe(false);
    expect(hay.has("cat")).toBe(false);
  });

  test("childhood query does not add child/kid unless those tokens are in the query", () => {
    const hay = queryHay("where is my childhood home");
    expect(hay.has("child")).toBe(false);
    expect(hay.has("kid")).toBe(false);
    expect(queryHay("the child sat down").has("child")).toBe(true);
  });

  test("literal diet from tokenize+skip is kept", () => {
    expect(queryHay("what diet am I on").has("diet")).toBe(true);
  });

  test("moved/stay do not fold into live hay", () => {
    expect(queryHay("we moved last week").has("live")).toBe(false);
    expect(queryHay("where they stay").has("live")).toBe(false);
  });

  test("best restaurant does not retrieve a diet-allergy fact via injected hay", () => {
    withMem((mem) => {
      mem.remember("Kai has a peanut diet allergy and skips dairy.");
      mem.remember("The best restaurant downtown is Noma.");
      const hits = mem.notesFor("best restaurant");
      expect(hits.some((r) => /Noma|restaurant/i.test(r.text))).toBe(true);
      expect(hits.some((r) => /diet allergy|peanut/i.test(r.text))).toBe(false);
    });
  });
});

describe("M4.2 noteBonus / pinEnvFact gone", () => {
  test("src/index.ts has no noteBonus or pinEnvFact", () => {
    expect(INDEX_SRC).not.toMatch(/function noteBonus\b/);
    expect(INDEX_SRC).not.toMatch(/function pinEnvFact\b/);
    expect(INDEX_SRC).not.toMatch(/pinEnvFact\(/);
    expect(INDEX_SRC).not.toMatch(/circleci/i);
    expect(INDEX_SRC).not.toMatch(/buildkite/i);
    expect(INDEX_SRC).not.toMatch(/staging\.example/);
  });

  test("set up ci / configure ci do not hard-pin CircleCI", () => {
    withMem((mem) => {
      mem.remember("CI is CircleCI");
      mem.remember("CI is GitHub Actions");
      for (const q of ["set up ci", "configure ci"]) {
        expect(mem.notesFor(q)[0]?.text ?? "").not.toBe("CI is CircleCI");
      }
      const equal = mem.notesFor("github actions circleci").map((r) => r.text);
      expect(equal.some((t) => /GitHub Actions/i.test(t))).toBe(true);
    });
  });

  test.failing(
    "set up ci does not pin CircleCI over a better lexical GitHub Actions note even when CircleCI is newer",
    () => {
      withMem((mem) => {
        mem.remember("CI is GitHub Actions and we set up ci with reusable workflows");
        mem.remember("CI is CircleCI");
        const top = mem.notesFor("set up ci")[0]?.text ?? "";
        expect(top).not.toBe("CI is CircleCI");
        expect(top).toMatch(/GitHub Actions/i);
      });
    },
  );

  test.failing("watch file-watcher is not boosted as a movie", () => {
    withMem((mem) => {
      mem.remember("We watched the movie Arrival last night");
      mem.remember("Add a file watcher on src/index.ts");
      const flake = mem.notesFor("the file watcher is flaking");
      const watchIdx = flake.findIndex((r) => /file watcher/i.test(r.text));
      const movieIdx = flake.findIndex((r) => /Arrival/i.test(r.text));
      expect(watchIdx).toBeGreaterThanOrEqual(0);
      if (movieIdx >= 0) expect(watchIdx).toBeLessThan(movieIdx);

      const files = mem.notesFor("watch the files for changes");
      const w2 = files.findIndex((r) => /file watcher/i.test(r.text));
      const m2 = files.findIndex((r) => /Arrival/i.test(r.text));
      expect(w2).toBeGreaterThanOrEqual(0);
      if (m2 >= 0) expect(w2).toBeLessThan(m2);

      // Bare "watch" must still surface the watcher (not movie-only). Tie-break vs
      // "watched" on a single token can follow recency/`at` and is not a movie bonus.
      expect(mem.notesFor("watch").some((r) => /file watcher/i.test(r.text))).toBe(true);
    });
  });

  test.failing("watch-files query does not retrieve a movie note that never said watch", () => {
    withMem((mem) => {
      mem.remember("Arrival is a great movie about first contact.");
      mem.remember("Add a file watcher on src/index.ts");
      const files = mem.notesFor("watch the files for changes");
      expect(files.some((r) => /file watcher/i.test(r.text))).toBe(true);
      expect(files.some((r) => /Arrival/i.test(r.text))).toBe(false);
    });
  });
});

describe("M4.3 place + subject", () => {
  test('pathCues keeps auth.ts on "never mock src/lib/auth.ts in unit tests."', () => {
    expect(pathCues("never mock src/lib/auth.ts in unit tests.").has("auth.ts")).toBe(true);
  });

  test("pathCues keeps dotted names in quotes, backticks, parens, Auth.ts case, and auth.test.ts", () => {
    expect(pathCues('never mock "auth.ts" in unit tests.').has("auth.ts")).toBe(true);
    expect(pathCues("never mock `auth.ts` in unit tests.").has("auth.ts")).toBe(true);
    expect(pathCues("never mock (auth.ts) in unit tests.").has("auth.ts")).toBe(true);
    expect(pathCues("the flake is in Auth.ts").has("auth.ts")).toBe(true);
    expect(pathCues('never mock "Auth.ts"').has("auth.ts")).toBe(true);
    const slashed = pathCues("the flake is in src/auth.test.ts");
    expect(slashed.has("auth.test.ts")).toBe(true);
    expect(pathCues("the flake is in auth.test.ts").has("auth.test.ts")).toBe(true);
  });

  test("notesFor auth.ts after observe still finds the mock rule", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Never mock src/lib/auth.ts in unit tests." }]);
      expect(mem.notesFor("auth.ts").some((r) => /auth\.ts/i.test(r.text))).toBe(true);
    });
  });

  test("Auth is failing does not delete Clerk", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      const blob = mem.memories().map((r) => r.text).join("\n");
      expect(blob).toMatch(/Clerk/);
    });
  });

  test("CI is failing does not delete CI identity", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: "CI is GitHub Actions" }]);
      mem.observe([{ role: "user", content: "CI is failing" }]);
      const blob = mem.memories().map((r) => r.text).join("\n");
      expect(blob).toMatch(/GitHub Actions/);
    });
  });
});

describe("Report §5.1 leftover binary IDF", () => {
  // Report §5.1 leftover: binary IDF (no TF, no length norm) is known; not M4's rewrite.
  test.failing("relevant() still uses Robertson-style binary IDF; no BM25 rewrite this wave", () => {
    const src = relevantSrc();
    expect(src).toContain("Math.log((N - d + 0.5) / (d + 0.5) + 1)");
    expect(src).not.toMatch(/\bBM25\b/);
    expect(src).not.toMatch(/\bk1\b/);
    expect(src).not.toMatch(/avgdl/);
    expect(src).not.toMatch(/termFrequency|term_frequency|\btf\s*\*/i);
  });
});

describe("No QUERY_LIGHT / -ship in product ranker", () => {
  test.failing("src/index.ts has no QUERY_LIGHT and no -ship stemmer hack; liteStem is ok", () => {
    expect(INDEX_SRC).toMatch(/function liteStem\b/);
    expect(INDEX_SRC).not.toMatch(/QUERY_LIGHT/);
    expect(INDEX_SRC).not.toMatch(/endsWith\(\s*["']ship["']\s*\)/);
  });
});

describe("M34.2 retrieve loop", () => {
  test.failing("relevant() body has no diet/childhood/pets hay expansions; binary IDF stays", () => {
    const src = relevantSrc();
    expect(src).toContain("queryHay(text)");
    expect(src).not.toMatch(/\b(diet|childhood|pets|stained|adoption)\b/);
    // Report §5.1 leftover: binary IDF (no TF, no length norm) is known; not this wave's rewrite.
    expect(src).toContain("Math.log((N - d + 0.5) / (d + 0.5) + 1)");
    expect(src).toContain("1.55");
    expect(src).not.toMatch(/\bBM25\b/);
  });

  test("restaurant query still hits Noma not diet, including when most rows miss", () => {
    withMem((mem) => {
      mem.remember("Kai has a peanut diet allergy and skips dairy.");
      mem.remember("The best restaurant downtown is Noma.");
      for (let i = 0; i < 40; i++) mem.remember(`Unrelated quartz plumbing note number ${i} about valves and gaskets.`);
      const hits = mem.notesFor("best restaurant");
      expect(hits.some((r) => /Noma|restaurant/i.test(r.text))).toBe(true);
      expect(hits[0]?.text ?? "").toMatch(/Noma/);
      expect(hits.some((r) => /diet allergy|peanut/i.test(r.text))).toBe(false);
      expect(hits.some((r) => /quartz plumbing/i.test(r.text))).toBe(false);
    });
  });

  test("auth.ts is a cue and Clerk survives Auth is failing", () => {
    expect(pathCues("never mock src/lib/auth.ts in unit tests.").has("auth.ts")).toBe(true);
    withMem((mem) => {
      mem.observe([{ role: "user", content: "Never mock src/lib/auth.ts in unit tests." }]);
      expect(mem.notesFor("auth.ts").some((r) => /auth\.ts/i.test(r.text))).toBe(true);
      mem.observe([{ role: "user", content: "Auth is Clerk" }]);
      mem.observe([{ role: "user", content: "Auth is failing" }]);
      expect(mem.memories().map((r) => r.text).join("\n")).toMatch(/Clerk/);
    });
  });
});
