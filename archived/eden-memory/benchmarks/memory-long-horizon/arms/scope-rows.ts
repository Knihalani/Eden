/**
 * The R5 unit rows arm (A5 §4; D3, A4 §2): the 12 required rows of R5 §9.3 plus R3 F9's, each a small repo built on
 * disk, asking the scope catalog where a path belongs. R3 F9's fourth row (a path under `.claude/worktrees/agent-x/`)
 * is R5's row k. Its root-only-monorepo row expected a two-segment fallback, which D3 replaced with R5's rule:
 * manifest-less services get scopes from `.eden/scopes` (R5 §9.2 step 9), so the row lists them there.
 *
 * The catalog is inside Eden. The arm asks it through an entry point it defines, run in the row's repo:
 *
 *   eden memory scopes --json <path>…   →   {"scopes": [scope…], "of": {"<path>": {"repo", "scope"}…}}
 *
 * Until a slice provides it, every row fails with the reason. P3.1 provides it, as written: the command builds the
 * catalog of the repo it runs in from that repo's files at the time, and a path, relative to the command's folder,
 * is answered with its own repo's key (D1) and that repo's scope.
 */
import type { SimWorld } from "../harness/session";
import { SUBJECTS } from "./fixtures/world";
import { check, jsonOut, type Arm, type ArmRun, type Check } from "./kit";

interface ScopeAnswer {
  scopes: string[];
  of: Record<string, { repo: string; scope: string }>;
}

export function readScopes(value: unknown): ScopeAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { scopes, of } = value as Partial<ScopeAnswer>;
  return Array.isArray(scopes) && of && typeof of === "object" ? { scopes, of } : undefined;
}

/** One row: a repo's files, the paths to ask about with their expected scopes, and any extra condition. */
interface Row {
  id: string;
  files: Record<string, string>;
  expect: Record<string, string>;
  /** Paths whose scope must not be in the catalog at all (min-2). */
  absent?: string[];
  /** Build the row's world beyond its files (a worktree) and return more paths to ask about. */
  extra?: (world: SimWorld) => { paths: Record<string, string>; sameRepo?: [string, string] };
}

const pkg = (name: string, more: Record<string, unknown> = {}) => JSON.stringify({ name, private: true, ...more });
const crate = (name: string) => `[package]\nname = "${name}"\nversion = "0.1.0"\n`;

/** The Bazel row's tree: 1,000 files under `enterprise/`, with or without a Bazel root. */
function bazelTree(withModule: boolean): Record<string, string> {
  const files: Record<string, string> = { "README.md": "# monorepo\n", "src/main.go": "package main\n" };
  if (withModule) files["MODULE.bazel"] = 'module(name = "acme")\n';
  for (let n = 0; n < 1_000; n++) files[`enterprise/svc/f${String(n).padStart(4, "0")}.go`] = "package svc\n";
  return files;
}

export const ROWS: Row[] = [
  {
    id: "row-a",
    files: {
      "Cargo.toml": crate("cargo"),
      "src/main.rs": "fn main() {}\n",
      "tests/testsuite/x/in/Cargo.toml": crate("in"),
      "tests/testsuite/x/in/src/lib.rs": "\n",
    },
    expect: { "tests/testsuite/x/in/src/lib.rs": "" },
  },
  {
    id: "row-b",
    files: {
      "Cargo.toml": '[workspace]\nmembers = ["tests/specs"]\n',
      "tests/specs/Cargo.toml": crate("specs"),
      "tests/specs/src/lib.rs": "\n",
    },
    expect: { "tests/specs/src/lib.rs": "tests/specs" },
  },
  {
    id: "row-c",
    files: {
      "package.json": pkg("root", { workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg("a"),
      "packages/a/index.js": "\n",
      "examples/foo/package.json": pkg("foo"),
      "examples/foo/index.js": "\n",
    },
    expect: { "examples/foo/index.js": "examples" },
  },
  {
    id: "row-d",
    files: {
      "pyproject.toml": '[project]\nname = "app"\n',
      "app.py": "\n",
      "archived/pyproject.toml": '[project]\nname = "old"\n',
      "archived/old.py": "\n",
    },
    expect: { "archived/old.py": "archived" },
  },
  {
    id: "row-e",
    files: {
      "package.json": pkg("root"),
      "examples/basic/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "examples/basic/apps/a/package.json": pkg("a"),
      "examples/basic/apps/a/index.js": "\n",
    },
    expect: { "examples/basic/apps/a/index.js": "examples" },
  },
  {
    id: "row-f",
    files: {
      "package.json": pkg("root", { workspaces: ["packages/*"] }),
      "packages/next/package.json": pkg("next"),
      "packages/next/src/index.js": "\n",
      "packages/next/src/compiled/@babel/runtime/package.json": pkg("@babel/runtime"),
      "packages/next/src/compiled/@babel/runtime/index.js": "\n",
    },
    expect: { "packages/next/src/compiled/@babel/runtime/index.js": "packages/next" },
  },
  {
    id: "row-g",
    files: {
      "package.json": pkg("root"),
      "nx.json": "{}\n",
      "libs/leaf/package.json": pkg("leaf"),
      "src/index.ts": "\n",
    },
    expect: { "libs/leaf/package.json": "" },
    absent: ["libs/leaf"],
  },
  {
    id: "row-h",
    files: { "package.json": pkg("root"), "crates/tiny/Cargo.toml": crate("tiny"), "crates/tiny/src/main.rs": "\n" },
    expect: { "crates/tiny/src/main.rs": "crates/tiny" },
  },
  {
    id: "row-i",
    files: {
      "README.md": "# arrow\n",
      "cpp/CMakeLists.txt": "cmake_minimum_required(VERSION 3.16)\nproject(Arrow VERSION 1.0)\n",
      "cpp/src/a.cc": "\n",
      "tools/CMakeLists.txt": "add_subdirectory(src)\n",
      "tools/src/b.cc": "\n",
    },
    expect: { "cpp/src/a.cc": "cpp", "tools/src/b.cc": "" },
  },
  {
    id: "row-j",
    files: bazelTree(true),
    expect: { "enterprise/svc/f0007.go": "enterprise" },
  },
  {
    id: "row-j-no-bazel",
    files: bazelTree(false),
    expect: { "enterprise/svc/f0007.go": "" },
  },
  {
    id: "row-k",
    files: {
      "package.json": pkg("root", { workspaces: ["packages/*"] }),
      "packages/know/package.json": pkg("know"),
      "packages/know/src/a.ts": "\n",
    },
    expect: { "packages/know/src/a.ts": "packages/know" },
    extra: (world) => {
      const tree = world.addWorktree(".claude/worktrees/agent-x", "agent-x");
      const inTree = `${tree.cwd}/packages/know/src/a.ts`;
      return { paths: { [inTree]: "packages/know" }, sameRepo: [inTree, "packages/know/src/a.ts"] };
    },
  },
  {
    id: "row-l",
    files: { "package.json": pkg("service"), "src/a.ts": "\n", "test/a.test.ts": "\n" },
    expect: { "src/a.ts": "", "test/a.test.ts": "" },
  },
  {
    id: "f9-fixture",
    files: {
      "package.json": pkg("root"),
      "src/a.ts": "\n",
      "test/fixtures/app/package.json": pkg("app"),
      "test/fixtures/app/index.js": "\n",
    },
    expect: { "test/fixtures/app/index.js": "" },
  },
  {
    id: "f9-root-only",
    files: {
      "pyproject.toml": '[project]\nname = "platform"\n',
      ".eden/scopes": "services/*\n",
      "services/a/main.py": "\n",
      "services/a/util.py": "\n",
      "services/b/main.py": "\n",
      "services/b/util.py": "\n",
    },
    expect: { "services/a/main.py": "services/a", "services/b/main.py": "services/b" },
  },
  {
    id: "f9-uv",
    files: {
      "pyproject.toml": '[project]\nname = "root"\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/a/pyproject.toml": '[project]\nname = "a"\n',
      "packages/a/a.py": "\n",
    },
    expect: { "packages/a/a.py": "packages/a" },
  },
];

function rowCheck(run: ArmRun, row: Row): Check {
  const world = run.world(
    { scopes: [""], subjects: SUBJECTS, projectFiles: row.files, initialTruth: [], secrets: [], poison: [] },
    { projectName: row.id },
  );
  const extra = row.extra?.(world);
  const expect = { ...row.expect, ...extra?.paths };
  const answer = readScopes(jsonOut(run.cli(world, ["memory", "scopes", "--json", ...Object.keys(expect)])));
  if (!answer) return check(row.id, false, "`eden memory scopes --json` gave no answer in the contract's shape");
  const wrong = Object.entries(expect).filter(([path, scope]) => answer.of[path]?.scope !== scope);
  const listed = (row.absent ?? []).filter((scope) => answer.scopes.includes(scope));
  const [a, b] = extra?.sameRepo ?? [];
  const split = a !== undefined && b !== undefined && answer.of[a]?.repo !== answer.of[b]?.repo;
  const detail = [
    ...wrong.map(
      ([path, scope]) => `${path}: ${JSON.stringify(answer.of[path]?.scope)}, expected ${JSON.stringify(scope)}`,
    ),
    ...listed.map((scope) => `${scope} is a scope`),
    ...(split ? ["the worktree path is in another repo"] : []),
  ];
  return check(row.id, detail.length === 0, detail.join("; ") || "as R5 §9 says");
}

export const r5UnitRows: Arm = {
  id: "r5-unit-rows",
  flagged: false,
  run: async (run) => ROWS.map((row) => rowCheck(run, row)),
};
