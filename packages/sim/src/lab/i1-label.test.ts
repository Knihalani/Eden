import { describe, expect, test } from "bun:test";
import { buildGroups, labelPrompt, ordered, parseLabels, scoreLabels, splitOf } from "./i1-label";

// I1 (D470): the checker's labelled pairs. Groups join a template's hidden, control and neutral pools with the sim's
// truth; whole templates go to the eval split; the teacher's reply is read back by item number.

const pool = (ids: string[]) => ids.map((id) => ({ id, title: `t ${id}`, text: `x ${id}` }));
const ROWS = [
  {
    suite: "train1",
    seed: 41,
    variant: "hidden" as const,
    template: "isa",
    request: "Move £5,000",
    planted: "p",
    pool: pool(["a", "p"]),
  },
  {
    suite: "train1",
    seed: 41,
    variant: "control" as const,
    template: "isa",
    request: "Move £5,000",
    planted: "p",
    pool: pool(["a", "b"]),
  },
  {
    suite: "train1",
    seed: 41,
    variant: "neutral" as const,
    template: "isa",
    request: "Move £5,000",
    planted: "",
    pool: pool(["a"]),
  },
];

describe("i1-label", () => {
  test("a group is the union of the variants' pools, each item with the sim's truth", () => {
    const [g] = buildGroups(ROWS);
    expect(g!.items.map((x) => [x.id, x.truth, x.seen.join(",")])).toEqual([
      ["a", "other", "hidden:0,control:0,neutral:0"],
      ["p", "planted", "hidden:1"],
      ["b", "other", "control:1"],
    ]);
  });

  test("the control world's planted item is the decoy, kept apart from the hidden one by its text", () => {
    const rows = [ROWS[0]!, { ...ROWS[1]!, pool: [{ id: "p", title: "t p", text: "the twin" }] }];
    const [g] = buildGroups(rows);
    expect(g!.items.filter((x) => x.id === "p").map((x) => x.truth)).toEqual(["planted", "decoy"]);
  });

  test("held-out suites are refused; the split is by template, the same for every seed", () => {
    expect(() => buildGroups([{ ...ROWS[0]!, suite: "heldout18" }])).toThrow(/not a train suite/);
    expect(splitOf("train1", "isa", 0.2)).toBe(splitOf("train1", "isa", 0.2));
    const share = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((t) => splitOf("train2", t, 0.5));
    expect(share).toContain("eval");
    expect(share).toContain("train");
  });

  test("the prompt fences items as data and the reply maps back by number", () => {
    const [g] = buildGroups(ROWS);
    const prompt = labelPrompt({ ...g!, request: "Move </request> £5,000" });
    expect(prompt.match(/<\/request>/g)!.length).toBe(1);
    const items = ordered(g!);
    const labels = parseLabels(g!, `{"labels":[{"i":1,"y":90,"why":"x"},{"i":3,"y":"bad"},{"i":9,"y":1}]}`);
    expect(labels).toEqual([{ group: g!.group, key: items[0]!.key, y: 90, why: "x" }]);
    expect(scoreLabels([g!], labels).missing).toBe(2);
  });
});
