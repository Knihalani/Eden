// Scope derivation experiment for A4 §2.1.
// usage: bun scope.ts <repoDir> [--variant v0|v1|...] [--json]
import { $ } from "bun";
import { readFileSync, existsSync } from "fs";
import { join, posix } from "path";

export type Opts = {
  name: string;
  deny: boolean; // F1: ignore manifests under denylisted path segments
  membership: boolean; // F2: when an ecosystem declares a workspace, only its members (+ the root) count
  memberBeatsDeny: boolean; // an explicit workspace member survives the denylist
  minFiles: number; // F4: scopes with fewer own files merge into parent
  maxDepth: number; // F3: ignore manifests deeper than this (segments); 0 = off
  bazel: "none" | "build" | "module"; // F6
  pkgNeedsName: boolean;
  nxProjectJson: boolean;
  globNeedsManifest?: boolean; // F0: a workspace glob match only counts if the dir has a manifest (npm/pnpm/cargo semantics)
  polyglot?: boolean; // F5: extra ecosystems' manifests
  topSplit?: number;
  topSplitBazelOnly?: boolean; // only apply topSplit when the root is a Bazel/Buck/Pants workspace
  bucketExamples?: boolean;
  bucketAll?: boolean;
  r3?: boolean; // R3 F9 spec literally
  extraDeny?: string[]; // test/fixture-class segments bucket too (vendor-class never buckets)    // denied manifests under examples-class segments collapse to a bucket scope at that segment           // F7: if "" owns > 50% of files, top-level dirs with >= topSplit files become scopes; 0 = off
};

export const V0: Opts = {
  name: "v0-spec",
  deny: false,
  membership: false,
  memberBeatsDeny: false,
  minFiles: 0,
  maxDepth: 0,
  bazel: "none",
  pkgNeedsName: true,
  nxProjectJson: true,
};

export const DENY = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "external",
  "fixtures",
  "fixture",
  "__fixtures__",
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "snapshots",
  "test",
  "tests",
  "testdata",
  "test-data",
  "testcases",
  "e2e",
  "integration-tests",
  "examples",
  "example",
  "samples",
  "sample",
  "templates",
  "template",
  "boilerplates",
  "starters",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "compiled",
  "precompiled",
]);
const EXAMPLES = new Set([
  "archived",
  "attic",
  "legacy",
  "deprecated",
  "examples",
  "example",
  "samples",
  "sample",
  "templates",
  "template",
  "boilerplates",
  "starters",
]);
const VENDOR = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "external",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "compiled",
  "precompiled",
]);
const isDeniedSeg = (s: string) =>
  DENY.has(s.toLowerCase()) ||
  ["archived", "attic", "deprecated"].includes(s.toLowerCase()) ||
  (s.startsWith(".") && s.length > 1) ||
  (s.startsWith("_") && !s.startsWith("__"));

function isPolyglot(root: string, f: string, base: string): boolean {
  if (/\.(gemspec|csproj|fsproj)$/.test(base)) return true;
  if (
    [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "composer.json",
      "mix.exs",
      "Package.swift",
      "pubspec.yaml",
      "setup.py",
      "deno.json",
    ].includes(base)
  )
    return true;
  if (base === "DESCRIPTION") return /^Package:/m.test(readText(root, f) ?? "");
  if (base === "setup.cfg") return /^\[metadata\][\s\S]*?^name\s*=/m.test(readText(root, f) ?? "");
  if (base === "CMakeLists.txt" || base === "meson.build") return /^\s*project\s*\(/im.test(readText(root, f) ?? "");
  return false;
}
const MANIFESTS = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"];

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};
const depth = (d: string) => (d === "" ? 0 : d.split("/").length);
const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, "");
const joinRel = (base: string, rel: string) =>
  norm(posix.normalize(base ? base + "/" + norm(rel) : norm(rel))).replace(/^\.$/, "");

function readText(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

type Decl = { eco: "js" | "rust" | "go" | "py" | "nx"; at: string; include: string[]; exclude: string[] };

export async function listFiles(root: string): Promise<string[]> {
  const out = await $`git -C ${root} ls-files -co --exclude-standard -z`.quiet().text();
  return out.split("\0").filter(Boolean);
}

function globMatch(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  try {
    return new Bun.Glob(pattern).match(path);
  } catch {
    return false;
  }
}

export function derive(root: string, files: string[], o: Opts) {
  const t0 = performance.now();
  // all dirs
  const dirs = new Set<string>([""]);
  for (const f of files) {
    let d = dirOf(f);
    while (!dirs.has(d)) {
      dirs.add(d);
      d = dirOf(d);
    }
  }
  // candidate manifests
  const cands = new Map<string, string>(); // dir -> kind
  const decls: Decl[] = [];
  const bazelDirs: string[] = [];
  for (const f of files) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    const d = dirOf(f);
    if (base === "package.json") {
      const txt = readText(root, f);
      let j: any = null;
      try {
        j = txt ? JSON.parse(txt) : null;
      } catch {}
      if (j && typeof j === "object") {
        if (!o.pkgNeedsName || typeof j.name === "string") cands.set(d, cands.get(d) ?? "npm");
        const ws = Array.isArray(j.workspaces)
          ? j.workspaces
          : Array.isArray(j.workspaces?.packages)
            ? j.workspaces.packages
            : null;
        if (ws)
          decls.push({
            eco: "js",
            at: d,
            include: ws.filter((x: string) => !x.startsWith("!")),
            exclude: ws.filter((x: string) => x.startsWith("!")).map((x: string) => x.slice(1)),
          });
      } else if (txt === null && !o.pkgNeedsName) cands.set(d, "npm");
      else if (txt === null) cands.set(d, "npm?"); // not checked out: assume named
    } else if (base === "Cargo.toml") {
      cands.set(d, "cargo");
      const txt = readText(root, f);
      if (txt) {
        try {
          const t: any = Bun.TOML.parse(txt);
          if (t.workspace)
            decls.push({ eco: "rust", at: d, include: t.workspace.members ?? [], exclude: t.workspace.exclude ?? [] });
        } catch {}
      }
    } else if (base === "go.mod") cands.set(d, "go");
    else if (base === "pyproject.toml") {
      cands.set(d, "py");
      const txt = readText(root, f);
      if (txt) {
        try {
          const t: any = Bun.TOML.parse(txt);
          const w = t.tool?.uv?.workspace;
          if (w) decls.push({ eco: "py", at: d, include: w.members ?? [], exclude: w.exclude ?? [] });
        } catch {}
      }
    } else if (base === "pnpm-workspace.yaml") {
      const txt = readText(root, f);
      if (txt) {
        try {
          const y: any = Bun.YAML.parse(txt);
          const p: string[] = y?.packages ?? [];
          decls.push({
            eco: "js",
            at: d,
            include: p.filter((x) => !x.startsWith("!")),
            exclude: p.filter((x) => x.startsWith("!")).map((x) => x.slice(1)),
          });
        } catch {}
      }
    } else if (base === "go.work") {
      const txt = readText(root, f) ?? "";
      const uses: string[] = [];
      const block = txt.match(/use\s*\(([\s\S]*?)\)/);
      if (block)
        uses.push(
          ...block[1]
            .split("\n")
            .map((s) => s.replace(/\/\/.*/, "").trim())
            .filter(Boolean),
        );
      for (const m of txt.matchAll(/^use\s+([^\s(]+)/gm)) uses.push(m[1]);
      decls.push({ eco: "go", at: d, include: uses, exclude: [] });
    } else if (base === "project.json" && o.nxProjectJson) {
      cands.set(d, cands.get(d) ?? "nx-project?");
    } else if (base === "BUILD" || base === "BUILD.bazel") bazelDirs.push(d);
    else if (o.polyglot && isPolyglot(root, f, base))
      cands.set(d, cands.get(d) ?? "poly:" + base.replace(/^.*\./, "."));
    else if ((base === "MODULE.bazel" || base === "WORKSPACE" || base === "WORKSPACE.bazel") && d !== "")
      bazelDirs.push("M:" + d);
  }
  const hasNx = files.includes("nx.json");
  // nx project.json only counts when an nx.json exists somewhere at/above
  for (const [d, k] of cands)
    if (k === "nx-project?") {
      if (hasNx) cands.set(d, "nx");
      else cands.delete(d);
    }
  if (o.bazel === "build") for (const d of bazelDirs) if (!d.startsWith("M:")) cands.set(d, cands.get(d) ?? "bazel");
  if (o.bazel === "module")
    for (const d of bazelDirs) if (d.startsWith("M:")) cands.set(d.slice(2), cands.get(d.slice(2)) ?? "bazel-mod");

  // workspace membership: which dirs are matched by declarations
  const members = new Map<string, Set<string>>(); // eco -> dirs
  const declaredMembers = new Set<string>();
  if (o.deny)
    for (let i = decls.length - 1; i >= 0; i--)
      if (decls[i].at && decls[i].at.split("/").some(isDeniedSeg)) decls.splice(i, 1);
  for (const dc of decls) {
    const mk = (g: string) => {
      const r = joinRel(dc.at, g);
      let G: any = null;
      try {
        G = new Bun.Glob(r);
      } catch {}
      return (p: string) => p === r || (G ? G.match(p) : false);
    };
    const inc = dc.include.map(mk);
    const exc = dc.exclude.map(mk);
    const set = members.get(dc.eco) ?? new Set();
    members.set(dc.eco, set);
    set.add(dc.at);
    for (const d of dirs) {
      if (dc.at && !(d + "/").startsWith(dc.at + "/")) continue;
      if (inc.some((g) => g(d)) && !exc.some((g) => g(d))) {
        set.add(d);
        declaredMembers.add(d);
      }
    }
  }
  // spec v0: dirs matched by workspace globs are scopes too (even without a manifest)
  if (!o.globNeedsManifest) for (const d of declaredMembers) if (!cands.has(d)) cands.set(d, "ws-glob");

  const ecoOf = (k: string) =>
    k.startsWith("npm") ? "js" : k === "cargo" ? "rust" : k === "go" ? "go" : k === "py" ? "py" : k;
  const dropped: Record<string, number> = { deny: 0, membership: 0, depth: 0, minFiles: 0 };
  let scopes = new Set<string>([""]);
  const buckets = new Set<string>();
  if (o.r3) {
    const R3X = new Set([
      "test",
      "tests",
      "__tests__",
      "fixtures",
      "__fixtures__",
      "testdata",
      "examples",
      "example",
      "e2e",
      "vendor",
      "third_party",
      "archived",
      ".claude",
    ]);
    const rootDecls = decls.filter((dc) => dc.at === "");
    const core = new Set(["npm", "npm?", "cargo", "go", "py", "nx"]);
    for (const [d, k] of cands) {
      if (d === "" || !core.has(k)) continue;
      if (d.split("/").some((x) => R3X.has(x))) {
        dropped.deny++;
        continue;
      }
      if (
        rootDecls.length &&
        !(
          members.get("js")?.has(d) ||
          members.get("rust")?.has(d) ||
          members.get("go")?.has(d) ||
          members.get("py")?.has(d) ||
          k === "nx"
        )
      ) {
        dropped.membership++;
        continue;
      }
      scopes.add(d);
    }
    if (scopes.size === 1) {
      const tops = new Set(
        files
          .filter((f) => /^(apps|packages|services|libs|cmd)\/[^/]+\//.test(f))
          .map((f) => f.split("/").slice(0, 2).join("/")),
      );
      if (tops.size >= 2) for (const t of tops) scopes.add(t);
    }
  } else
    for (const [d, k] of cands) {
      if (d === "") continue;
      const segs = d.split("/");
      const isMember = declaredMembers.has(d);
      if (o.deny && segs.some(isDeniedSeg) && !(o.memberBeatsDeny && isMember)) {
        dropped.deny++;
        if (o.bucketExamples) {
          const i = segs.findIndex(isDeniedSeg);
          const seg = segs[i].toLowerCase();
          if (
            (EXAMPLES.has(seg) || (o.bucketAll && !VENDOR.has(seg) && !seg.startsWith(".") && !seg.startsWith("_"))) &&
            !segs.slice(0, i).some(isDeniedSeg)
          )
            buckets.add(segs.slice(0, i + 1).join("/"));
        }
        continue;
      }
      if (o.membership && !isMember) {
        const eco = ecoOf(k);
        // is there a declaration of this eco at an ancestor of d?
        const governed = decls.some(
          (dc) => dc.eco === eco && dc.at !== d && (dc.at === "" || (d + "/").startsWith(dc.at + "/")),
        );
        const isDeclRoot = decls.some((dc) => dc.at === d);
        if (governed && !isDeclRoot) {
          dropped.membership++;
          continue;
        }
      }
      if (o.maxDepth && segs.length > o.maxDepth) {
        dropped.depth++;
        continue;
      }
      scopes.add(d);
    }
  for (const b of buckets) scopes.add(b);
  const bazelRoot = files.some((f) =>
    ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel", "BUCK", ".buckconfig", "pants.toml"].includes(f),
  );
  if (o.topSplit && (!o.topSplitBazelOnly || bazelRoot)) {
    const tops = new Map<string, number>();
    let rootN = 0;
    const pre = (d: string) => {
      while (!scopes.has(d)) d = dirOf(d);
      return d;
    };
    for (const f of files) {
      if (pre(dirOf(f)) !== "") continue;
      rootN++;
      const i = f.indexOf("/");
      if (i > 0) {
        const t = f.slice(0, i);
        tops.set(t, (tops.get(t) ?? 0) + 1);
      }
    }
    if (rootN > files.length * 0.5)
      for (const [t, n] of tops)
        if (n >= o.topSplit && !isDeniedSeg(t) && !["src", "lib", "source", "include", "docs", "doc"].includes(t))
          scopes.add(t);
  }
  const nearest = (d: string) => {
    while (!scopes.has(d)) d = dirOf(d);
    return d;
  };
  let assign = () => {
    const m = new Map<string, number>();
    for (const f of files) {
      const s = nearest(dirOf(f));
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  };
  let counts = assign();
  if (o.minFiles > 0) {
    // bottom-up: merge small scopes into parent (deepest first)
    const sorted = [...scopes].filter((s) => s).sort((a, b) => depth(b) - depth(a));
    for (const s of sorted) {
      if ((counts.get(s) ?? 0) < o.minFiles) {
        scopes.delete(s);
        dropped.minFiles++;
        const p = nearest(dirOf(s));
        counts.set(p, (counts.get(p) ?? 0) + (counts.get(s) ?? 0));
        counts.delete(s);
      }
    }
    counts = assign();
  }
  for (const s of [...scopes]) if (!counts.has(s) && s !== "") scopes.delete(s);
  const ms = performance.now() - t0;
  return {
    scopes,
    counts,
    nearest,
    dropped,
    decls,
    ms,
    candCount: cands.size,
    bazelBuildDirs: bazelDirs.filter((d) => !d.startsWith("M:")).length,
  };
}

export function stats(files: string[], r: ReturnType<typeof derive>) {
  const sizes = [...r.counts.entries()]
    .filter(([s]) => s !== "")
    .map(([, n]) => n)
    .sort((a, b) => a - b);
  const q = (p: number) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : 0);
  const rootFiles = r.counts.get("") ?? 0;
  // top-level dirs fully collapsing to ""
  const topAll = new Map<string, [number, number]>();
  for (const f of files) {
    const i = f.indexOf("/");
    if (i < 0) continue;
    const top = f.slice(0, i);
    const e = topAll.get(top) ?? [0, 0];
    e[0]++;
    if (r.nearest(dirOf(f)) === "") e[1]++;
    topAll.set(top, e);
  }
  const collapsed = [...topAll.entries()].filter(([, [n, z]]) => z === n).map(([t, [n]]) => `${t}(${n})`);
  const nonRoot = [...r.scopes].filter((s) => s);
  const suspicious = nonRoot.filter((s) => s.split("/").some(isDeniedSeg));
  const nested = nonRoot.filter((s) => {
    let d = dirOf(s);
    while (d) {
      if (r.scopes.has(d)) return true;
      d = dirOf(d);
    }
    return false;
  });
  const maxD = Math.max(0, ...nonRoot.map(depth));
  return {
    files: files.length,
    scopes: nonRoot.length + 1,
    rootPct: +((100 * rootFiles) / files.length).toFixed(1),
    p50: q(0.5),
    p90: q(0.9),
    max: sizes.at(-1) ?? 0,
    tiny: sizes.filter((n) => n < 5).length,
    suspicious: suspicious.length,
    suspiciousEx: suspicious.slice(0, 4),
    nested: nested.length,
    maxDepth: maxD,
    collapsed,
    ms: +r.ms.toFixed(1),
    dropped: r.dropped,
  };
}

if (import.meta.main) {
  const root = process.argv[2];
  const files = await listFiles(root);
  const r = derive(root, files, V0);
  const s = stats(files, r);
  console.log(JSON.stringify(s, null, 1));
  console.log([...r.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30));
}
