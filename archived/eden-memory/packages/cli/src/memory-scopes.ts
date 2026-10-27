/**
 * The scope catalog's commands (D3, A6 §3):
 *
 *   eden memory scopes [--json] [<path>…]
 *     →   {"scopes": [scope…], "of": {"<path>": {"repo", "scope"}…}}   (with --json)
 *   eden memory forget --all-in <scope>
 *
 * `scopes` builds the catalog of the repo it runs in from that repo's files now, stores it (unless memory is off or
 * read-only), and answers where each path belongs: its own repo (D1) and that repo's scope. A path is relative to the
 * folder the command runs in; outside git every scope is the root, in the repo the folder is (D1).
 *
 * `forget --all-in` sends every keyed row of a scope of this repo (a row stating rules, D9) to history. The scope is
 * one of the catalog's, or one a keyed row still carries after its folder was removed or renamed.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { openMemory, storeRows, superseded } from "../../../src/index";
import { memoryConsent } from "../../../src/memory-consent";
import { readableStore, repoIdentity, repoStoreDir } from "../../../src/memory-repo";
import {
  buildCatalog,
  catalogOf,
  normalizedFolder,
  repoPathOf,
  scopeOfDir,
  scopeOfFile,
  type ScopeCatalog,
} from "../../../src/memory-scopes";
import { memoryRoot } from "./memory-hook";

/** The catalog of the repo a folder is in, built now; stored only when memory may write and the store is readable. */
function freshCatalog(folder: string, key: string): ScopeCatalog | undefined {
  const store = repoStoreDir(memoryRoot(), key);
  const stores = memoryConsent() === "on" && readableStore(store);
  return stores ? buildCatalog(store, folder) : catalogOf(folder);
}

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** `eden memory scopes` (see the header). */
export function memoryScopesCli(args: readonly string[]): number {
  const cwd = process.cwd();
  const here = repoIdentity(cwd);
  if (!here) return 1;
  const catalogs = new Map<string, ScopeCatalog | undefined>([[here.key, freshCatalog(cwd, here.key)]]);
  const scopesOf = (key: string, folder: string) => {
    if (!catalogs.has(key)) catalogs.set(key, catalogOf(folder));
    return catalogs.get(key)?.scopes ?? [""];
  };
  const of: Record<string, { repo: string; scope: string }> = {};
  for (const path of args.filter((arg) => !arg.startsWith("-"))) {
    const absolute = resolve(cwd, path);
    const at = repoPathOf(absolute);
    if (!at) of[path] = { repo: here.key, scope: "" };
    else {
      const scopes = scopesOf(at.repo, at.top);
      of[path] = {
        repo: at.repo,
        scope: isDirectory(absolute) ? scopeOfDir(scopes, at.rel) : scopeOfFile(scopes, at.rel),
      };
    }
  }
  const scopes = catalogs.get(here.key)?.scopes ?? [""];
  if (args.includes("--json")) console.log(JSON.stringify({ scopes, of }));
  else {
    for (const scope of scopes) console.log(scope || '""');
    for (const [path, { scope }] of Object.entries(of)) console.log(`${path}: ${JSON.stringify(scope)}`);
  }
  return 0;
}

/** The scopes the store's live keyed rows carry. */
function keyedRowScopes(store: string): Set<string> {
  const rows = storeRows(join(store, "memories.jsonl"));
  return new Set(rows.filter((row) => row.rules?.length && !superseded(row)).map((row) => row.scope ?? ""));
}

/** `eden memory forget --all-in <scope>` (A6 §3). Exit 2 when the name is no scope of this repo. */
export function forgetScopeCli(args: readonly string[]): number {
  const named = args[args.indexOf("--all-in") + 1];
  const cwd = process.cwd();
  const here = repoIdentity(cwd);
  if (named === undefined || !here) {
    console.log("usage: eden memory forget --all-in <scope>");
    return 2;
  }
  if (memoryConsent() !== "on") {
    console.log(`forget: memory is ${memoryConsent()}; nothing changed`);
    return 1;
  }
  const store = repoStoreDir(memoryRoot(), here.key);
  // EXECUTION §9: a store in a format this code does not know is never read or written.
  if (!readableStore(store)) {
    console.log("forget: this repo's store is in a format this version does not know; nothing changed");
    return 1;
  }
  const scope = normalizedFolder(named);
  const scopes = new Set([...(freshCatalog(cwd, here.key)?.scopes ?? [""]), ...keyedRowScopes(store)]);
  if (!scopes.has(scope)) {
    const listed = [...scopes].sort().map((s) => JSON.stringify(s));
    console.log(`${named} is not a scope of this repo; its scopes: ${listed.join(", ")}`);
    return 2;
  }
  const mem = openMemory({ dir: store, perRepo: true });
  try {
    const forgot = mem.forgetScope(scope);
    console.log(`forgot ${forgot} keyed row${forgot === 1 ? "" : "s"} in ${scope || '"" (the repo root)'}`);
  } finally {
    mem.close();
  }
  return 0;
}
