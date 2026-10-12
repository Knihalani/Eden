/**
 * P3.1: the scope catalog (D3, A4 §2, R5 §9). The rule is a pure function of a repo's file list and the manifests'
 * text, tested step by step (R5 §9.2) and on R5 §9.3's and R3 F9's rows; the catalog is built from the main
 * checkout's `git ls-files -co --exclude-standard`, persisted in the repo store, and looked up without the filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoKeyOf } from "./memory-repo";
import {
  buildCatalog,
  deriveScopes,
  readCatalog,
  rebuildsCatalog,
  repoFiles,
  repoPathOf,
  scopeOfDir,
  scopeOfFile,
} from "./memory-scopes";

const pkg = (name?: string, more: Record<string, unknown> = {}) =>
  JSON.stringify({ ...(name ? { name } : {}), ...more });
const crate = (name: string) => `[package]\nname = "${name}"\n`;

/** The scopes R5 §9.2 derives from a tree of file paths and their text. */
function derive(tree: Record<string, string>) {
  return deriveScopes(Object.keys(tree), (path) => tree[path]);
}

const scopesOf = (tree: Record<string, string>) => derive(tree).scopes;

describe("R5 §9.2 step 2: the manifest set", () => {
  test("a package.json is a manifest only with a string name", () => {
    expect(scopesOf({ "a/package.json": pkg("a"), "a/i.js": "", "b/package.json": pkg(), "b/i.js": "" })).toEqual([
      "",
      "a",
    ]);
    expect(scopesOf({ "a/package.json": '{"name": 3}', "a/i.js": "" })).toEqual([""]);
    expect(scopesOf({ "a/package.json": "not json", "a/i.js": "" })).toEqual([""]);
  });

  test("Cargo.toml, go.mod, pyproject.toml, deno.json, setup.py and the polyglot names need no content", () => {
    const names = [
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "deno.json",
      "setup.py",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "acme.gemspec",
      "Acme.csproj",
      "Acme.fsproj",
      "composer.json",
      "mix.exs",
      "Package.swift",
      "pubspec.yaml",
    ];
    for (const name of names) expect(scopesOf({ [`m/${name}`]: "", "m/x": "" })).toEqual(["", "m"]);
  });

  test("setup.cfg needs a [metadata] name; DESCRIPTION a first field Package:", () => {
    expect(scopesOf({ "p/setup.cfg": "[metadata]\nname = p\n", "p/x.py": "" })).toEqual(["", "p"]);
    expect(scopesOf({ "p/setup.cfg": "[tool:pytest]\naddopts = -q\n", "p/x.py": "" })).toEqual([""]);
    expect(scopesOf({ "p/setup.cfg": "[options]\nname = p\n[metadata]\nversion = 1\n", "p/x.py": "" })).toEqual([""]);
    expect(scopesOf({ "r/DESCRIPTION": "Package: arrow\nTitle: x\n", "r/R/a.R": "" })).toEqual(["", "r"]);
    expect(scopesOf({ "r/DESCRIPTION": "Title: x\nPackage: arrow\n", "r/R/a.R": "" })).toEqual([""]);
  });

  test("CMakeLists.txt and meson.build need a project( line", () => {
    expect(scopesOf({ "c/CMakeLists.txt": "  project (C)\n", "c/a.cc": "" })).toEqual(["", "c"]);
    expect(scopesOf({ "c/meson.build": "project('c', 'c')\n", "c/a.c": "" })).toEqual(["", "c"]);
    expect(scopesOf({ "c/CMakeLists.txt": "add_subdirectory(src) # project(C)\n", "c/a.cc": "" })).toEqual([""]);
  });

  test("project.json counts only with nx.json in the files; a Bazel BUILD never does", () => {
    const nx = { "libs/a/project.json": "{}", "libs/a/i.ts": "" };
    expect(scopesOf(nx)).toEqual([""]);
    expect(scopesOf({ ...nx, "nx.json": "{}" })).toEqual(["", "libs/a"]);
    expect(scopesOf({ "MODULE.bazel": "", "svc/BUILD": "", "svc/BUILD.bazel": "", "svc/a.go": "" })).toEqual([""]);
  });
});

describe("R5 §9.2 step 3: workspace declarations", () => {
  const twoTests = { "tests/a/Cargo.toml": crate("a"), "tests/a/l.rs": "", "tests/b/Cargo.toml": crate("b") };

  test("package.json workspaces (array, or .packages) name members, which beat exclusion", () => {
    const tree = { ...twoTests, "tests/b/l.rs": "" };
    expect(scopesOf({ ...tree, "package.json": pkg("r", { workspaces: ["tests/*"] }) })).toEqual([
      "",
      "tests/a",
      "tests/b",
    ]);
    expect(scopesOf({ ...tree, "package.json": pkg("r", { workspaces: { packages: ["tests/a"] } }) })).toEqual([
      "",
      "tests/a",
    ]);
  });

  test("pnpm-workspace.yaml packages, with ! negation and ./ or trailing / forms", () => {
    const tree = {
      ...twoTests,
      "tests/b/l.rs": "",
      "pnpm-workspace.yaml": "packages:\n  - './tests/*/'\n  - '!tests/b'\n",
    };
    expect(scopesOf(tree)).toEqual(["", "tests/a"]);
  });

  test("Cargo [workspace].members minus .exclude; uv's [tool.uv.workspace] the same", () => {
    const cargo = '[workspace]\nmembers = ["tests/*"]\nexclude = ["tests/b"]\n';
    expect(scopesOf({ ...twoTests, "tests/b/l.rs": "", "Cargo.toml": cargo })).toEqual(["", "tests/a"]);
    const uv = '[project]\nname = "r"\n[tool.uv.workspace]\nmembers = ["tests/*"]\nexclude = ["tests/a"]\n';
    const py = { "tests/a/pyproject.toml": "", "tests/a/a.py": "", "tests/b/pyproject.toml": "", "tests/b/b.py": "" };
    expect(scopesOf({ ...py, "pyproject.toml": uv })).toEqual(["", "tests/b"]);
  });

  test("go.work use, one per line or in a block", () => {
    const mods = { "testdata/a/go.mod": "", "testdata/a/a.go": "", "testdata/b/go.mod": "", "testdata/b/b.go": "" };
    expect(scopesOf({ ...mods, "go.work": "go 1.22\nuse ./testdata/a\n" })).toEqual(["", "testdata/a"]);
    expect(scopesOf({ ...mods, "go.work": "go 1.22\nuse (\n\t./testdata/a\n\t./testdata/b // b\n)\n" })).toEqual([
      "",
      "testdata/a",
      "testdata/b",
    ]);
  });

  test("globs resolve from the declaring file's directory", () => {
    const tree = {
      "tools/package.json": pkg("tools", { workspaces: ["fixtures/*"] }),
      "tools/t.js": "",
      "tools/fixtures/x/package.json": pkg("x"),
      "tools/fixtures/x/i.js": "",
    };
    expect(scopesOf(tree)).toEqual(["", "tools", "tools/fixtures/x"]);
  });

  test("a glob match without a manifest is no scope", () => {
    const tree = { "package.json": pkg("r", { workspaces: ["benchmarks/*"] }), "benchmarks/lme/run.ts": "" };
    expect(scopesOf({ ...tree, "benchmarks/lme/data.json": "" })).toEqual([""]);
  });

  test("a declaration inside an excluded directory is ignored (row e)", () => {
    const tree = {
      "examples/basic/package.json": pkg("basic", { workspaces: ["apps/*"] }),
      "examples/basic/apps/a/package.json": pkg("a"),
      "examples/basic/apps/a/i.js": "",
    };
    expect(scopesOf(tree)).toEqual(["", "examples"]);
  });
});

describe("R5 §9.2 steps 4–5: exclusion and buckets", () => {
  test("a VENDOR, TEST, dot or single-underscore segment excludes, in any case; its files stay with their package", () => {
    for (const dir of ["Vendor", "third-party", "node_modules", "__tests__", "TestData", ".hidden", "_tools"]) {
      const tree = { "package.json": pkg("r"), [`${dir}/x/package.json`]: pkg("x"), [`${dir}/x/i.js`]: "" };
      expect(derive(tree).scopes).toEqual([""]);
    }
    const dunder = { "__pkg__/package.json": pkg("p"), "__pkg__/i.js": "" };
    expect(scopesOf(dunder)).toEqual(["", "__pkg__"]);
  });

  test("an EXAMPLE segment buckets every excluded manifest under it into one scope", () => {
    const tree = {
      "examples/a/package.json": pkg("a"),
      "examples/a/i.js": "",
      "examples/b/package.json": pkg("b"),
      "packages/foo/package.json": pkg("foo"),
      "packages/foo/i.js": "",
      "packages/foo/templates/t/package.json": pkg("t"),
      "packages/foo/templates/t/i.js": "",
    };
    expect(scopesOf(tree)).toEqual(["", "examples", "packages/foo", "packages/foo/templates"]);
  });

  test("a bucket needs a manifest under it, and an earlier excluded segment wins", () => {
    expect(scopesOf({ "package.json": pkg("r"), "examples/a.js": "", "examples/b.js": "" })).toEqual([""]);
    const vendored = { "vendor/examples/x/package.json": pkg("x"), "vendor/examples/x/i.js": "" };
    expect(scopesOf(vendored)).toEqual([""]);
  });
});

describe("R5 §9.2 step 7: minimum size", () => {
  test("a scope owning only its manifest is dropped, deepest first, and named as waiting", () => {
    const tree = { "a/package.json": pkg("a"), "a/b/package.json": pkg("b"), "a/b/x.js": "" };
    expect(derive(tree)).toEqual({ scopes: ["", "a/b"], waiting: ["a"] });
    const nested = { "a/package.json": pkg("a"), "a/x.js": "", "a/b/package.json": pkg("b") };
    expect(derive(nested)).toEqual({ scopes: ["", "a"], waiting: ["a/b"] });
  });

  test("a bucket owning one file waits too", () => {
    expect(derive({ "examples/a/package.json": pkg("a") })).toEqual({ scopes: [""], waiting: ["examples"] });
  });
});

describe("R5 §9.2 step 8: the Bazel/Buck/Pants fallback", () => {
  function tree(root: string, sizes: Record<string, number>, rest: Record<string, string> = {}) {
    const files: Record<string, string> = { [root]: "", ...rest };
    for (const [dir, n] of Object.entries(sizes)) for (let i = 0; i < n; i++) files[`${dir}/f${i}.go`] = "";
    return files;
  }

  test('at a Bazel root where "" owns over half the files, each top-level dir of ≥ 200 files is a scope', () => {
    for (const root of ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel", "BUCK", ".buckconfig", "pants.toml"])
      expect(scopesOf(tree(root, { app: 200, cli: 199 }))).toEqual(["", "app"]);
  });

  test("never src, lib, source, include, docs, doc or an excluded name", () => {
    const names = ["src", "lib", "source", "include", "docs", "doc", "third_party", "tests", ".ci"];
    expect(scopesOf(tree("MODULE.bazel", Object.fromEntries(names.map((name) => [name, 250]))))).toEqual([""]);
  });

  test('not when "" owns half the files or less, and not without a Bazel root file', () => {
    const owned = { "svc/go.mod": "", ...Object.fromEntries([...Array(300)].map((_, i) => [`svc/f${i}.go`, ""])) };
    expect(scopesOf(tree("MODULE.bazel", { app: 250 }, owned))).toEqual(["", "svc"]);
    expect(scopesOf(tree("README.md", { app: 250 }))).toEqual([""]);
  });
});

describe("R5 §9.2 step 9: the .eden/scopes override", () => {
  test("adds the directories each glob matches and removes those a !glob matches, never the root", () => {
    const tree = {
      "package.json": pkg("r", { workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg("a"),
      "packages/a/i.js": "",
      "services/x/main.py": "",
      "services/y/main.py": "",
      ".eden/scopes": "# product folders\nservices/*\n\n!packages/a\n!services/y/\n!\n",
    };
    expect(scopesOf(tree)).toEqual(["", "services/x"]);
  });
});

/**
 * R5 §9.3's rows and R3 F9's, restated here (the `r5-unit-rows` arm checks them through the CLI against its own
 * oracle; EXECUTION X6 keeps product tests off the harness). Row k, a worktree path, is the git test below.
 */
describe("R5 §9.3 and R3 F9 rows, as a pure function", () => {
  const big = (root: boolean) => {
    const files: Record<string, string> = {
      "README.md": "",
      "src/main.go": "",
      ...(root ? { "MODULE.bazel": "" } : {}),
    };
    for (let n = 0; n < 1_000; n++) files[`enterprise/svc/f${n}.go`] = "";
    return files;
  };
  const rows: { id: string; files: Record<string, string>; expect: Record<string, string>; absent?: string[] }[] = [
    {
      id: "a: a cargo-style test-suite crate is no scope",
      files: { "Cargo.toml": crate("c"), "src/main.rs": "", "tests/testsuite/x/in/Cargo.toml": crate("in") },
      expect: { "tests/testsuite/x/in/src/lib.rs": "" },
    },
    {
      id: "b: a member beats exclusion",
      files: {
        "Cargo.toml": '[workspace]\nmembers = ["tests/specs"]\n',
        "tests/specs/Cargo.toml": "",
        "tests/specs/a": "",
      },
      expect: { "tests/specs/src/lib.rs": "tests/specs" },
    },
    {
      id: "c: an example app buckets",
      files: { "package.json": pkg("r"), "examples/foo/package.json": pkg("foo"), "examples/foo/i.js": "" },
      expect: { "examples/foo/i.js": "examples" },
    },
    {
      id: "d: archived",
      files: { "pyproject.toml": "", "app.py": "", "archived/pyproject.toml": "", "archived/old.py": "" },
      expect: { "archived/old.py": "archived" },
    },
    {
      id: "e: a workspace inside an example is ignored",
      files: {
        "examples/basic/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "examples/basic/apps/a/package.json": pkg("a"),
        "examples/basic/apps/a/i.js": "",
      },
      expect: { "examples/basic/apps/a/i.js": "examples" },
    },
    {
      id: "f: a compiled vendored package belongs to its package",
      files: {
        "package.json": pkg("r", { workspaces: ["packages/*"] }),
        "packages/next/package.json": pkg("next"),
        "packages/next/src/compiled/@babel/runtime/package.json": pkg("@babel/runtime"),
        "packages/next/src/compiled/@babel/runtime/i.js": "",
      },
      expect: { "packages/next/src/compiled/@babel/runtime/i.js": "packages/next" },
    },
    {
      id: "g: a manifest-only leaf is no scope",
      files: { "package.json": pkg("r"), "nx.json": "{}", "libs/leaf/package.json": pkg("leaf"), "src/i.ts": "" },
      expect: { "libs/leaf/package.json": "" },
      absent: ["libs/leaf"],
    },
    {
      id: "h: a 2-file crate is a scope",
      files: { "crates/tiny/Cargo.toml": crate("tiny"), "crates/tiny/src/main.rs": "" },
      expect: { "crates/tiny/src/main.rs": "crates/tiny" },
    },
    {
      id: "i: CMake with project( only",
      files: {
        "cpp/CMakeLists.txt": "project(Arrow VERSION 1.0)\n",
        "cpp/src/a.cc": "",
        "tools/CMakeLists.txt": "add_subdirectory(src)\n",
        "tools/src/b.cc": "",
      },
      expect: { "cpp/src/a.cc": "cpp", "tools/src/b.cc": "" },
    },
    { id: "j: a Bazel root's big folder", files: big(true), expect: { "enterprise/svc/f7.go": "enterprise" } },
    { id: "j: no Bazel root", files: big(false), expect: { "enterprise/svc/f7.go": "" } },
    {
      id: "l: a single package's src and test",
      files: { "package.json": pkg("s"), "src/a.ts": "", "test/a.test.ts": "" },
      expect: { "src/a.ts": "", "test/a.test.ts": "" },
    },
    {
      id: "F9: a test fixture's manifest",
      files: { "package.json": pkg("r"), "test/fixtures/app/package.json": pkg("app"), "test/fixtures/app/i.js": "" },
      expect: { "test/fixtures/app/i.js": "" },
    },
    {
      id: "F9: a root-only monorepo through .eden/scopes",
      files: { "pyproject.toml": "", ".eden/scopes": "services/*\n", "services/a/m.py": "", "services/b/m.py": "" },
      expect: { "services/a/m.py": "services/a", "services/b/m.py": "services/b" },
    },
    {
      id: "F9: a uv workspace",
      files: {
        "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
        "packages/a/pyproject.toml": "",
        "packages/a/a.py": "",
      },
      expect: { "packages/a/a.py": "packages/a" },
    },
  ];
  for (const row of rows)
    test(row.id, () => {
      const { scopes } = derive(row.files);
      for (const [path, scope] of Object.entries(row.expect))
        expect([path, scopeOfFile(scopes, path)]).toEqual([path, scope]);
      for (const absent of row.absent ?? []) expect(scopes).not.toContain(absent);
    });
});

describe("step 10: lookup", () => {
  const scopes = ["", "apps/web", "apps/web/ui", "packages/cli"];

  test("a file's scope is the longest scope prefixing its directory on a / boundary", () => {
    expect(scopeOfFile(scopes, "apps/web/src/a.ts")).toBe("apps/web");
    expect(scopeOfFile(scopes, "apps/web/ui/b.tsx")).toBe("apps/web/ui");
    expect(scopeOfFile(scopes, "apps/webby/a.ts")).toBe("");
    expect(scopeOfFile(scopes, "apps/web")).toBe("");
    expect(scopeOfFile(scopes, "README.md")).toBe("");
  });

  test("a directory's scope counts the directory itself", () => {
    expect(scopeOfDir(scopes, "apps/web")).toBe("apps/web");
    expect(scopeOfDir(scopes, "packages/cli/src")).toBe("packages/cli");
    expect(scopeOfDir(scopes, "")).toBe("");
  });

  test("the scopes come out sorted", () => {
    const tree = { "z/go.mod": "", "z/a.go": "", "a/go.mod": "", "a/a.go": "", "m/go.mod": "", "m/a.go": "" };
    expect(scopesOf(tree)).toEqual(["", "a", "m", "z"]);
  });
});

describe("with git (§9.1, step 1, persistence)", () => {
  let dir = "";
  let top = "";

  function git(cwd: string, ...args: string[]): string {
    const run = Bun.spawnSync(["git", ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
      stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString();
  }

  function put(base: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), text);
    }
  }

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), "eden-scopes-")));
    top = join(dir, "repo");
    put(top, {
      "package.json": pkg("r", { workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg("a"),
      "packages/a/i.js": "",
      ".gitignore": "dist/\n",
    });
    git(top, "init", "-q", "-b", "main");
    git(top, "add", "-A");
    git(top, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the files are tracked plus untracked-not-ignored, never an ignored or nested repo's", () => {
    put(top, { "packages/b/package.json": pkg("b"), "packages/b/i.js": "", "dist/package.json": pkg("d") });
    git(top, "worktree", "add", "-q", ".claude/worktrees/agent-x");
    const files = repoFiles(top)!;
    expect(files).toContain("packages/a/i.js");
    expect(files).toContain("packages/b/i.js");
    expect(files.some((file) => file.startsWith("dist/") || file.startsWith(".claude/"))).toBe(false);
    expect(repoFiles(join(dir, "nowhere"))).toBeUndefined();
  });

  test("a path maps to its repo and to a path relative to its own worktree's top", () => {
    const tree = join(top, ".claude/worktrees/agent-x");
    git(top, "worktree", "add", "-q", ".claude/worktrees/agent-x");
    const key = repoKeyOf(join(top, ".git"));
    expect(repoPathOf(join(top, "packages/a/i.js"))).toEqual({ repo: key, top, rel: "packages/a/i.js" });
    expect(repoPathOf(join(tree, "packages/a/i.js"))).toEqual({ repo: key, top: tree, rel: "packages/a/i.js" });
    // A file not written yet maps through its nearest existing directory; a link through what it resolves to.
    expect(repoPathOf(join(top, "packages/a/new/x.ts"))?.rel).toBe("packages/a/new/x.ts");
    symlinkSync(join(top, "packages"), join(dir, "link"));
    expect(repoPathOf(join(dir, "link/a/i.js"))).toEqual({ repo: key, top, rel: "packages/a/i.js" });
    expect(repoPathOf(join(dir, "outside.txt"))).toBeUndefined();
    expect(repoPathOf("relative/path")).toBeUndefined();
  });

  test("a build lists the main checkout's files, from any worktree, and persists the catalog", () => {
    git(top, "worktree", "add", "-q", join(dir, "wt"));
    put(join(dir, "wt"), { "packages/only-here/package.json": pkg("o"), "packages/only-here/i.js": "" });
    const store = join(dir, "store");
    const built = buildCatalog(store, join(dir, "wt"))!;
    expect(built.scopes).toEqual(["", "packages/a"]);
    expect(built.checkout).toBe(top);
    expect(readCatalog(store)).toEqual(built);
    expect(JSON.parse(readFileSync(join(store, "scopes.json"), "utf8")).scopes).toEqual(["", "packages/a"]);
  });

  test("outside git there is nothing to build, and a missing or broken catalog reads as none", () => {
    mkdirSync(join(dir, "plain"));
    expect(buildCatalog(join(dir, "store"), join(dir, "plain"))).toBeUndefined();
    expect(readCatalog(join(dir, "store"))).toBeUndefined();
    mkdirSync(join(dir, "store"), { recursive: true });
    writeFileSync(join(dir, "store", "scopes.json"), "{ not json");
    expect(readCatalog(join(dir, "store"))).toBeUndefined();
  });
});

describe("rebuild triggers (A4 §2: after a Write/Edit of a manifest or workspace file)", () => {
  const catalog = { built: 1, checkout: "/r", scopes: ["", "packages/a"], waiting: ["packages/new"] };

  test("a manifest, workspace or override file, or a file in a waiting directory, rebuilds", () => {
    for (const rel of [
      "packages/b/package.json",
      "Cargo.toml",
      "pnpm-workspace.yaml",
      "go.work",
      "nx.json",
      "x/acme.gemspec",
      "cpp/CMakeLists.txt",
      "MODULE.bazel",
      ".eden/scopes",
      "packages/new/index.ts",
    ])
      expect([rel, rebuildsCatalog(catalog, [rel])]).toEqual([rel, true]);
  });

  test("any other file does not, and with no catalog yet nothing does (the turn's end builds it)", () => {
    expect(rebuildsCatalog(catalog, ["packages/a/i.js", "packages/newer/i.js", "README.md"])).toBe(false);
    expect(rebuildsCatalog(undefined, ["package.json"])).toBe(false);
  });
});

/** Code review round 1's probes (P3.1), kept as regression tests. */
describe("review round 1", () => {
  describe("waiting directories and the batch trigger", () => {
    test("a dropped folder whose other files belong to deeper scopes stays waiting", () => {
      const files = {
        "package.json": pkg("root", { workspaces: ["tools", "tools/*"] }),
        "tools/package.json": pkg("tools"),
        "tools/a/package.json": pkg("a"),
        "tools/a/x.js": "",
        "tools/a/y.js": "",
      };
      const c = derive(files);
      // tools owns only its manifest, so it waits; tools/a is a scope.
      expect(c).toEqual({ scopes: ["", "tools/a"], waiting: ["tools"] });
      const catalog = { built: 0, checkout: "/x", ...c };
      // A file tools/a owns cannot end the wait, so it rebuilds nothing; one tools owns does.
      expect(rebuildsCatalog(catalog, ["tools/a/x.js"])).toBe(false);
      expect(rebuildsCatalog(catalog, ["tools/x.js"])).toBe(true);
    });
  });

  describe("step 2 edge cases", () => {
    test("a package.json with a name only of whitespace is no manifest", () => {
      expect(derive({ "a/package.json": pkg("  "), "a/x.js": "" }).scopes).toEqual([""]);
    });
    test("DESCRIPTION whose first field is not Package: is no manifest", () => {
      expect(derive({ "r/DESCRIPTION": "Title: x\nPackage: y\n", "r/x.R": "" }).scopes).toEqual([""]);
      expect(derive({ "r/DESCRIPTION": "Package: y\n", "r/x.R": "" }).scopes).toEqual(["", "r"]);
    });
    test("a manifest whose read fails (missing, unreadable) is no candidate for content manifests", () => {
      expect(deriveScopes(["a/package.json", "a/x.js"], () => undefined).scopes).toEqual([""]);
    });
  });

  describe("step 5 buckets", () => {
    test("a TEST segment before an EXAMPLE one: no bucket", () => {
      expect(derive({ "test/examples/a/package.json": pkg("a"), "test/examples/a/x.js": "" }).scopes).toEqual([""]);
    });
    test("a manifest at the bucket folder itself makes the bucket", () => {
      expect(derive({ "examples/package.json": pkg("ex"), "examples/x.js": "" }).scopes).toEqual(["", "examples"]);
    });
  });

  describe("step 9 override", () => {
    test("a !glob removes an override scope added on an earlier line, and never the root", () => {
      const files = { ".eden/scopes": "tools/*\n!tools/b\n!**\n", "tools/a/x": "", "tools/b/y": "" };
      expect(derive(files).scopes).toEqual([""]);
    });
    test("an override glob matching a file name only adds no scope", () => {
      expect(derive({ ".eden/scopes": "*.md\n", "README.md": "" }).scopes).toEqual([""]);
    });
  });

  describe("step 10 lookup", () => {
    test("a sibling with the same prefix is not owned", () => {
      expect(scopeOfFile(["", "packages/a"], "packages/ab/x.ts")).toBe("");
    });
  });

  describe("names inherited from Object.prototype", () => {
    test("a file named constructor or toString is no manifest and rebuilds nothing", () => {
      expect(derive({ "a/constructor": "", "a/x.js": "", "b/toString": "", "b/y.js": "" }).scopes).toEqual([""]);
      const catalog = { built: 0, checkout: "/x", scopes: [""], waiting: [] };
      expect(rebuildsCatalog(catalog, ["src/toString"])).toBe(false);
    });
  });
});
