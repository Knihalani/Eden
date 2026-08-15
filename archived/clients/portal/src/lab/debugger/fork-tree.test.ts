import { describe, expect, it } from "vitest";

import { buildForkTree, forkRowId } from "./fork-tree";

describe("buildForkTree", () => {
  it("groups forks by parent_fork_id with roots first", () => {
    const tree = buildForkTree([
      { fork_id: "root-a", parent_fork_id: null, fork_at_step: 1 },
      { fork_id: "child-b", parent_fork_id: "root-a", fork_at_step: 3 },
      { fork_id: "child-a", parent_fork_id: "root-a", fork_at_step: 2 },
      { fork_id: "root-b", parent_fork_id: undefined, fork_at_step: 0 },
    ]);

    expect(tree.map((n) => forkRowId(n.fork))).toEqual(["root-b", "root-a"]);
    expect(tree[1].children.map((n) => forkRowId(n.fork))).toEqual([
      "child-a",
      "child-b",
    ]);
  });

  it("treats missing parent as root when parent is unknown", () => {
    const tree = buildForkTree([
      { fork_id: "orphan", parent_fork_id: "missing-parent", fork_at_step: 1 },
    ]);
    expect(tree).toHaveLength(1);
    expect(forkRowId(tree[0].fork)).toBe("orphan");
    expect(tree[0].children).toHaveLength(0);
  });
});
