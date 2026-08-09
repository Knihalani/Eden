/** Fork row from time-travel listForks (loosely typed API records). */
export type ForkListRow = {
  fork_id?: string;
  id?: string;
  parent_fork_id?: string | null;
  fork_at_step?: number;
  name?: string;
  last_replay_outcome?: string;
};

export type ForkTreeNode = {
  fork: ForkListRow;
  children: ForkTreeNode[];
};

export function forkRowId(fork: ForkListRow): string {
  return String(fork.fork_id || fork.id || "");
}

/** Group flat forks into a nested tree by parent_fork_id (roots = null parent). */
export function buildForkTree(forks: ForkListRow[]): ForkTreeNode[] {
  const nodes = new Map<string, ForkTreeNode>();
  const roots: ForkTreeNode[] = [];

  for (const fork of forks) {
    const id = forkRowId(fork);
    if (!id) continue;
    nodes.set(id, { fork, children: [] });
  }

  for (const fork of forks) {
    const id = forkRowId(fork);
    const node = nodes.get(id);
    if (!node) continue;

    const parentId = fork.parent_fork_id;
    if (parentId != null && parentId !== "" && nodes.has(String(parentId))) {
      nodes.get(String(parentId))!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortBranch = (branch: ForkTreeNode[]) => {
    branch.sort(
      (a, b) => (a.fork.fork_at_step ?? 0) - (b.fork.fork_at_step ?? 0),
    );
    for (const n of branch) sortBranch(n.children);
  };
  sortBranch(roots);

  return roots;
}
