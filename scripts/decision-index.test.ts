import { describe, expect, test } from "bun:test";
import {
  cells,
  classify,
  clauses,
  generate,
  numbersIn,
  parseDecisions,
  stale,
  summarize,
  topicOf,
  type Verdict,
} from "./decision-index";

/** A DECISIONS.md in miniature: the main table, a heading, the trials table. */
function doc(rows: string[], trials: string[] = []): string {
  return [
    "# Decisions",
    "",
    "| # | Date | Decision | Why |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Trial switches",
    "",
    "| Trial | Switch | Owner | Ends | What decides it |",
    "|---|---|---|---|---|",
    ...trials,
    "",
  ].join("\n");
}

function verdicts(rows: string[], trials: string[] = []): Map<string, Verdict> {
  const parsed = parseDecisions(doc(rows, trials));
  return classify(parsed.rows, parsed.trials);
}

const status = (v: Map<string, Verdict>, label: string) => v.get(label)?.status;

describe("parsing", () => {
  test("cells keep escaped pipes inside a cell", () => {
    expect(cells("| D1 | 2026-10-27 | a \\| b | why |")).toEqual(["D1", "2026-10-27", "a \\| b", "why"]);
  });

  test("numbers: single, en-dash and hyphen ranges; a wide span is two numbers", () => {
    expect(numbersIn("D7")).toEqual([7]);
    expect(numbersIn("Push check (D500–D502)")).toEqual([500, 501, 502]);
    expect(numbersIn("D184-D186")).toEqual([184, 185, 186]);
    expect(numbersIn("D1–D99")).toEqual([1]);
  });

  test("rows, a range row and the trials table", () => {
    const { rows, trials } = parseDecisions(
      doc(
        ["| D1 | 2026-10-27 | One. | Why. |", "| D496–D499 | 2026-11-10 | Unused. |"],
        ["| A (D1) | `a` | o | x | y |"],
      ),
    );
    expect(rows.map((r) => [r.label, r.numbers])).toEqual([
      ["D1", [1]],
      ["D496–D499", [496, 497, 498, 499]],
    ]);
    expect(rows[1]!.why).toBe("");
    expect(trials).toEqual([{ name: "A (D1)", numbers: [1] }]);
  });

  test("clauses never split inside brackets or code", () => {
    expect(clauses("The graph (`a`; D58, D107) is deleted; `b.c` stays. Next one")).toEqual([
      "The graph (`a`; D58, D107) is deleted",
      "`b.c` stays",
      "Next one",
    ]);
  });
});

describe("summaries", () => {
  test("the bold lead, with provenance brackets dropped", () => {
    expect(summarize("**Rejected: a thing (deep audit 2026-11-04; may collide).** Body.")).toBe("Rejected: a thing.");
    expect(summarize("**`pushOpen` (D702) is promoted (O3)** Body.")).toBe("`pushOpen` (D702) is promoted");
  });

  test("without a lead: the first sentence past a Proposed opener", () => {
    expect(summarize("Proposed (track graph). A per-user graph, off by default. More.")).toBe(
      "A per-user graph, off by default.",
    );
    expect(summarize("Rejected (deep audit x; docs/research/y.md). The pool is not widened. Then.")).toBe(
      "Rejected: The pool is not widened.",
    );
  });

  test("a lead ending in a colon takes the sentence after it", () => {
    expect(summarize("**Not built, on $0 evidence:** (1) a census line. (2) more")).toBe(
      "Not built, on $0 evidence: (1) a census line.",
    );
  });

  test("trimmed at a word with an ellipsis, a cut code span closed, pipes and HTML made safe", () => {
    const s = summarize(`**${"word ".repeat(30)}\`code span that runs on\`**`, 160);
    expect([...s].length).toBeLessThanOrEqual(161);
    expect(s.endsWith("…`") || s.endsWith("…")).toBe(true);
    expect((s.match(/`/g) ?? []).length % 2).toBe(0);
    expect(summarize("**a | b <x> `<y>`**")).toBe("a \\| b &lt;x> `<y>`");
  });
});

describe("statuses", () => {
  test("finding, lab and an open trial come from the row itself and the trials table", () => {
    const v = verdicts(
      [
        "| D1 | d | **Finding: x does not help.** | |",
        "| D2 | d | **Lab only: a harness flag.** | |",
        "| D3 | d | **Pre-registered: the run.** | |",
        "| D4 | d | **Trial `x` (owner o, ends e): x.** | |",
      ],
      ["| X (D4) | `x` | o | e | rule |"],
    );
    expect([1, 2, 3, 4].map((n) => status(v, `D${n}`))).toEqual(["finding", "lab", "lab", "trial"]);
  });

  test("a row's own lead rejects; the first clause decides", () => {
    const v = verdicts([
      "| D1 | d | **Rejected: a thing.** | |",
      "| D2 | d | **Moving the push is not built** | |",
      "| D3 | d | **X is rejected; Y comes back as a trial** | |",
      "| D4 | d | **`graph` stays in the default; deleting the graph's code is rejected** | |",
      "| D5 | d | **A user's file is deleted when its newest item expires** | |",
      "| D6 | d | **Trial `t` (N3), opened and closed: not promoted, deleted.** | |",
      "| D7 | d | **Deleted: `r` with its code.** | |",
      "| D8 | d | **A plain adoption.** | Measured and deleted. |",
    ]);
    expect(["D1", "D2", "D3"].map((l) => status(v, l))).toEqual(["rejected", "rejected", "rejected"]);
    expect(v.get("D4")).toEqual({ status: "adopted", killedPart: "deleting the graph's code is rejected" });
    expect(status(v, "D5")).toBe("adopted");
    expect(status(v, "D6")).toBe("rejected");
    expect(status(v, "D7")).toBe("rejected");
    expect(status(v, "D8")).toBe("rejected");
  });

  test("a later row deletes a trial by its switch, or promotes it", () => {
    const v = verdicts([
      "| D1 | d | **Trial `pushPointer`: names items.** | |",
      "| D2 | d | **Trial `pushOpen`: runs more.** | |",
      "| D3 | d | **`pushPointer` (D1) failed its rule and is deleted with its code and tests** | |",
      "| D4 | d | **`pushOpen` is promoted into the default as the part `open`** | |",
    ]);
    expect(v.get("D1")).toEqual({ status: "superseded", by: 3, deleted: true });
    expect(v.get("D2")).toEqual({ status: "adopted", by: 4 });
    expect(status(v, "D3")).toBe("rejected");
  });

  test("a proposed flag deleted in a later row's bold Deleted section", () => {
    const v = verdicts([
      "| D1 | d | Proposed (track x). `askRank` (with `m` 5), off by default: ranks asks. | |",
      "| D2 | d | **One product.** Body. **Deleted** (none helped): `askRank`, `supersede*`. | |",
    ]);
    expect(v.get("D1")).toEqual({ status: "superseded", by: 2, deleted: true });
  });

  test("pointers: 'deleted by' binds to the number just before it, else to its own row", () => {
    const v = verdicts([
      "| D1 | d | Intent. | |",
      "| D2 | d | A bridge. | |",
      "| D3 | d | **(Deleted by D9.)** **Trial `r`: re-show.** | |",
      "| D4 | d | **A note (deleted by D9).** | |",
      "| D9 | d | **One rule.** The intent requests (D1) or a bridge (D2, deleted by D9). | |",
    ]);
    expect(status(v, "D1")).toBe("adopted");
    expect(v.get("D2")).toEqual({ status: "superseded", by: 9, deleted: true });
    expect(v.get("D3")).toEqual({ status: "superseded", by: 9, deleted: true });
    expect(v.get("D4")).toEqual({ status: "superseded", by: 9, deleted: true });
  });

  test("amending, citing or keeping a number does not supersede it", () => {
    const v = verdicts([
      "| D1 | d | A cascade. | |",
      "| D2 | d | A wait. | |",
      "| D3 | d | A rule. | |",
      "| D4 | d | A poll. | |",
      "| D5 | d | **X changes.** This supersedes D1's always-on cascade. | |",
      "| D6 | d | **Answering early stays rejected (D2 holds)** | |",
      "| D7 | d | **Promoted: `p` is on in the default (A25; D3)** | |",
      "| D8 | d | **Rejected, lab only (numbered D4 on its branch).** | |",
      "| D9 | d | Later. **Rejected** in passing. Supersedes D3 | |",
    ]);
    expect(["D1", "D2", "D4"].map((l) => status(v, l))).toEqual(["adopted", "adopted", "adopted"]);
    expect(v.get("D3")).toEqual({ status: "superseded", by: 9, deleted: false });
  });

  test("lab tooling a later row deletes is a dead end; one in use stays lab", () => {
    const v = verdicts(["| D1 | d | **Lab only: a flag.** | Deleted (D2) |", "| D2 | d | **Finding: no.** | |"]);
    expect(v.get("D1")).toEqual({ status: "superseded", by: 2, deleted: true });
  });
});

describe("pages", () => {
  test("topics follow the keyword map", () => {
    expect(topicOf("Re-ranking the push's candidates")).toBe("Push and candidates");
    expect(topicOf("A shorter reader output schema")).toBe("Reader");
    expect(topicOf("Labelling rule-path packets")).toBe("Delivery and packet");
    expect(topicOf("Something else entirely")).toBe("Other");
  });

  test("dead ends list rejections, deletions and rejected parts, with the killer's reason", () => {
    const md = doc([
      "| D1 | d | **Trial `pushX`: more candidates.** | |",
      "| D2 | d | **`pushX` is rejected and deleted with its code and tests** (hidden −2.3 points (−4.0..+0.1)). | x |",
      "| D3 | d | **The reader's pool stays at 15; trimming it is rejected** | |",
      "| D4 | d | **A kept thing.** | |",
    ]);
    const { index, deadEnds } = generate(md);
    expect(index).toContain("4 decisions: adopted 2, rejected 1, superseded 1, trial 0, finding 0, lab 0.");
    expect(index).toContain("| D1 | d | Trial `pushX`: more candidates. | superseded (deleted by D2) |");
    expect(deadEnds).toContain(
      "| D1 | Trial `pushX`: more candidates. | deleted by D2: hidden −2.3 points (−4.0..+0.1) |",
    );
    expect(deadEnds).toContain("| D3 | part of: trimming it is rejected |");
    expect(deadEnds).not.toContain("| D4 |");
    expect(generate(md)).toEqual({ index, deadEnds });
  });

  test("the committed DECISION-INDEX.md and DEAD-ENDS.md are current (run `bun run decisions:index`)", () => {
    expect(stale()).toEqual([]);
  });
});
