/** WHATWG workstreams → `WHATWG html is HTML Living Standard`. Tiny JSON, not the living spec HTML. */

import { shortTitle, type Triple } from "./extract";

export const WHATWG_DB_URL = "https://github.com/whatwg/sg/raw/main/db.json";

type Std = { name?: string; href?: string; description?: string; reference?: string };
type Workstream = { id?: string; standards?: Std[] };
type Db = { workstreams?: Workstream[] };

function slugOf(std: Std): string | undefined {
  const ref = (std.reference || "").toLowerCase().replace(/[^a-z0-9-]+/g, "");
  if (ref) return ref;
  try {
    const host = new URL(std.href || "").hostname;
    const m = host.match(/^([a-z0-9-]+)\.spec\.whatwg\.org$/i);
    if (m) return m[1]!.toLowerCase();
  } catch {
    /* */
  }
  return (std.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || undefined;
}

export function parseWhatwgDb(json: unknown): Triple[] {
  const streams = (json as Db)?.workstreams;
  if (!Array.isArray(streams)) return [];
  const out: Triple[] = [];
  const seen = new Set<string>();
  for (const ws of streams) {
    for (const std of ws.standards || []) {
      const slug = slugOf(std);
      const name = (std.name || "").replace(/\s+/g, " ").trim();
      if (!slug || !name || seen.has(slug)) continue;
      const desc = (std.description || "").replace(/\s+/g, " ").trim();
      const o = shortTitle(name.length >= 8 ? name : desc || name);
      if (o.length < 3) continue;
      seen.add(slug);
      out.push({ s: `WHATWG ${slug}`, p: "is", o, e: "" });
    }
  }
  return out;
}
