/**
 * Parser-only adaptive infobox aliases (Scrapling idea, no fetcher).
 * Remembers label text that yielded a persistable capital/ISO so the next
 * Wikipedia skin still extracts. Never impersonates Chrome. Never in graph.kpk.
 */

const capital = new Set<string>([
  "capital",
  "official capital",
  "national capital",
  "capital city",
  "seat of government",
  "administrative centre",
  "administrative center",
  "administrative capital",
]);

function norm(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

export function noteCapitalLabel(label: string) {
  const t = norm(label);
  if (!t || t.length > 48 || /\bcountry\b/.test(t) || /\bcontinent\b/.test(t)) return;
  if (capital.size < 128) capital.add(t.replace(/[:.]+$/, ""));
}

export function adaptCapitalLabel(label: string): boolean {
  const t = norm(label);
  if (!t || /\bcountry\b/.test(t) || /\bcontinent\b/.test(t)) return false;
  if (capital.has(t) || capital.has(t.replace(/[:.]+$/, ""))) return true;
  const head = t.split(/[:(]/)[0]!.trim();
  return capital.has(head);
}

export function resetAdaptForTest() {
  capital.clear();
  for (const s of [
    "capital",
    "official capital",
    "national capital",
    "capital city",
    "seat of government",
    "administrative centre",
    "administrative center",
    "administrative capital",
  ])
    capital.add(s);
}
