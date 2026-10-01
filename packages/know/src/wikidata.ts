/** Wikidata SPARQL → country capitals + ISO 3166-1 alpha-2 (P297).
 * One GET. query.wikidata.org Disallow: /sparql — liveGet honors robots and
 * tickWikidata fail-opens (skipped:1). Parser still yields from JSON fixtures.
 */

import type { Triple } from "./extract";

const SPARQL = `SELECT ?countryLabel ?capitalLabel ?iso WHERE {
  ?country wdt:P31 wd:Q6256.
  ?country wdt:P36 ?capital.
  OPTIONAL { ?country wdt:P297 ?iso. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

export const WIKIDATA_SPARQL_URL = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(SPARQL)}`;

function tidyName(s: string): string | undefined {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 40) return undefined;
  if (/^Q\d+$/i.test(t)) return undefined;
  if (/https?:\/\//i.test(t)) return undefined;
  return t;
}

function tidyIso(s: string): string | undefined {
  const t = s.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(t)) return undefined;
  return t;
}

/** Capitals plus tidy ISO 3166-1 alpha-2 `id` facts. Skips Q-ids. Old JSON without `iso` still parses. */
export function parseWikidataCapitals(json: unknown): Triple[] {
  const bindings = (json as { results?: { bindings?: Record<string, { value?: string }>[] } })?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  const out: Triple[] = [];
  const seenCap = new Set<string>();
  const seenIso = new Set<string>();
  for (const row of bindings) {
    const country = tidyName(String(row.countryLabel?.value ?? ""));
    const capital = tidyName(String(row.capitalLabel?.value ?? ""));
    const iso = tidyIso(String(row.iso?.value ?? ""));
    if (country && capital && !seenCap.has(country)) {
      seenCap.add(country);
      out.push({
        s: country,
        p: "capital",
        o: capital,
        e: `capital of ${country} is ${capital}`,
      });
    }
    if (country && iso && !seenIso.has(country)) {
      seenIso.add(country);
      out.push({
        s: country,
        p: "id",
        o: iso,
        e: `${country} ISO 3166-1 alpha-2 ${iso}`,
      });
    }
  }
  return out;
}
