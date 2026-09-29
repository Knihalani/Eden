import { derive, stats, listFiles, V0, type Opts } from "./scope";
import { writeFileSync } from "fs";

const R = import.meta.dir + "/repos/";
// Human "product folder" ground truth (my judgment, written before looking at derived scopes).
// Product of a file = deepest ancestor dir matching one of these globs; else "".
export const TRUTH: Record<string, string[]> = {
  vercel_turborepo: ["apps/*", "packages/*", "crates/*", "docs/*", "examples/*", "lockfile-tests", "turborepo-tests/*", "packages/turbo-repository/rust"],
  "vercel_next.js": ["packages/*", "crates/*", "turbopack/crates/*", "apps/*", "bench/*", "examples/*", "rspack", "evals"],
  nrwl_nx: ["packages/*", "e2e/*", "graph/*", "nx-dev/*", "tools/*", "astro-docs", "benchmarks", "examples/*", "packages/nx/native-packages/*"],
  microsoft_vscode: ["extensions/*", "cli", "build", "remote", "test/*"],
  facebook_react: ["packages/*", "compiler/packages/*", "compiler/apps/*", "fixtures/*"],
  "tokio-rs_tokio": ["tokio", "tokio-util", "tokio-stream", "tokio-macros", "tokio-test", "tests-build", "tests-integration", "examples", "benches", "stress-test"],
  "rust-lang_cargo": ["crates/*", "credential/*", "benches/*"],
  golang_tools: ["gopls"],
  kubernetes_kubernetes: ["staging/src/k8s.io/*", "cmd/*", "pkg/*", "test/*"],
  "langchain-ai_langchain": ["libs/*", "libs/partners/*"],
  apache_airflow: ["providers/*", "providers/{apache,atlassian,cncf,common,dbt,ibm,microsoft}/*", "airflow-core/src/airflow/ui", "dev/breeze", "airflow-core", "task-sdk", "airflow-ctl", "go-sdk", "ts-sdk", "java-sdk", "chart", "shared/*", "devel-common", "clients/*"],
  sindresorhus_got: [],
  psf_requests: [],
  apache_arrow: ["cpp", "c_glib", "ruby", "ruby/*", "r", "matlab", "python"],
  "buildbuddy-io_buildbuddy": ["app", "server", "enterprise", "cli", "website", "codesearch"],
  babel_babel: ["packages/*", "eslint/*", "codemods/*"],
  supabase_supabase: ["apps/*", "packages/*", "blocks/*", "e2e/*", "examples/*/*"],
  denoland_deno: ["cli", "ext/*", "libs/*", "runtime", "tests/*"],
  Eden: ["apps/*", "packages/*", "benchmarks/*", "plugins/*", "examples/*", "archived", "archived/clients/*", "archived/sdk/*"],
};

export function truthOf(globs: string[]) {
  const gs = globs.map(g => new Bun.Glob(g));
  const cache = new Map<string, string>();
  const f = (d: string): string => {
    if (d === "") return "";
    const c = cache.get(d); if (c !== undefined) return c;
    const r = gs.some(g => g.match(d)) ? d : f(d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "");
    cache.set(d, r); return r;
  };
  return f;
}
const dirOf = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };

export function agreement(files: string[], r: ReturnType<typeof derive>, truth: string[]) {
  const t = truthOf(truth);
  let rootLeak = 0;
  let same = 0, deeper = 0, shallower = 0, other = 0;
  const prods = new Set<string>();
  for (const f of files) {
    const d = dirOf(f); const s = r.nearest(d); const p = t(d); if (p) prods.add(p);
    if (p !== "" && s === "") rootLeak++;
    if (s === p) same++;
    else if (s.startsWith(p ? p + "/" : "")) deeper++;
    else if (p.startsWith(s ? s + "/" : "")) shallower++;
    else other++;
  }
  const prodHit = [...prods].filter(p => r.scopes.has(p)).length;
  const pct = (n: number) => +(100 * n / files.length).toFixed(1);
  return { agree: pct(same), overSplit: pct(deeper), underSplit: pct(shallower), crossed: pct(other), rootLeak: pct(rootLeak), products: prods.size, prodRecall: prods.size ? +(100 * prodHit / prods.size).toFixed(0) : 100 };
}

const F1 = { ...V0, globNeedsManifest: true, deny: true, memberBeatsDeny: true };
export const VARIANTS: Opts[] = [
  V0,
  { ...V0, name: "F0 glob-needs-manifest", globNeedsManifest: true },
  { ...F1, name: "F0+F1 deny" },
  { ...V0, name: "F0+F2 membership", globNeedsManifest: true, membership: true },
  { ...F1, name: "F0+F1+F2", membership: true },
  { ...F1, name: "F0+F1+bucket", bucketExamples: true },
  { ...F1, name: "F0+F1+bucket+min2", bucketExamples: true, minFiles: 2 },
  { ...F1, name: "F0+F1+bucket+min3", bucketExamples: true, minFiles: 3 },
  { ...F1, name: "F0+F1+bucket+depth4", bucketExamples: true, maxDepth: 4 },
  { ...F1, name: "F0+F1+bucket+min2+poly", bucketExamples: true, minFiles: 2, polyglot: true },
  { ...F1, name: "…+top200 (any repo)", bucketExamples: true, minFiles: 2, polyglot: true, topSplit: 200 },
  { ...F1, name: "REC (…+top200 bazel-only)", bucketExamples: true, minFiles: 2, polyglot: true, topSplit: 200, topSplitBazelOnly: true },
  { ...F1, name: "REC but bucket all test/fixture", bucketExamples: true, bucketAll: true, minFiles: 2, polyglot: true, topSplit: 200, topSplitBazelOnly: true },
  { ...V0, name: "R3-F9 literal", r3: true },
  { ...F1, name: "bazel BUILD as manifest", bucketExamples: true, bazel: "build" },
];

if (import.meta.main) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TRUTH);
  const out: any[] = [];
  for (const n of names) {
    const root = n === "Eden" ? "/Users/kaiavnihalani/Downloads/Eden" : R + n;
    const t0 = performance.now();
    const files = await listFiles(root);
    const lsMs = performance.now() - t0;
    for (const v of VARIANTS) {
      const r = derive(root, files, v);
      const s = stats(files, r);
      const a = agreement(files, r, TRUTH[n]);
      out.push({ repo: n, variant: v.name, lsMs: +lsMs.toFixed(0), ...s, ...a, cands: r.candCount, decls: r.decls.map(d => `${d.eco}@${d.at || "."}`).join(",") });
      console.error(n, v.name, s.scopes, a.agree);
    }
  }
  writeFileSync(import.meta.dir + "/res/" + names.join("+") + ".json", JSON.stringify(out, null, 1));
}
if (import.meta.main) process.exit(0);
