/**
 * Dual-API gate helpers. Tests live in inject-only.test.ts / memory-audit.test.ts.
 * Importing this file must not register bun tests.
 */
export const NOT_PRODUCT_LINE = /\/\/\s*not-product|#\s*not-product/;

const DENIAL_WORD = /\b(?:not|no|never|forbid(?:den)?|do not|don't|cannot|can't|without|banned|ban|only if|unless)\b/i;
const SENTENCE = /(?<!\d)[.!?](?!\d)/;

/**
 * A denial governs a claim only inside the same clause, before the claim,
 * or as an immediate close (`: no`, `is not`, `only if`). A later "not"
 * after a comma or a new sentence does not hide the claim.
 */
export function claimDenied(line: string, start: number, end: number): boolean {
  if (NOT_PRODUCT_LINE.test(line)) return true;
  const clauseBefore = (line.slice(0, start).split(SENTENCE).pop() ?? "");
  if (DENIAL_WORD.test(clauseBefore)) return true;
  if (line.includes("|") && line.slice(end).split("|").some((cell) => DENIAL_WORD.test(cell))) return true;
  const clauseAfter = (line.slice(end).split(SENTENCE)[0] ?? "");
  if (/\b(?:is|are|was|were)\s+(?:no|not|never)\b/i.test(clauseAfter)) return true;
  if (/\b(?:only if|unless)\b/i.test(clauseAfter)) return true;
  const head = clauseAfter.split(",")[0] ?? "";
  return /\b(?:not|no|never|forbid(?:den)?|banned|ban)\b/i.test(head);
}

function isCodeLine(line: string): boolean {
  const t = line.trim();
  return Boolean(t) && !t.startsWith("//") && !t.startsWith("#") && !t.startsWith("*");
}

/** Import of BrainMemory / brain-memory module (JS + Python). */
export function isBrainMemoryImport(line: string): boolean {
  if (!isCodeLine(line)) return false;
  const jsNamed = /import\s*(?:type\s+)?(?:\{[^}]*\bBrainMemory\b[^}]*\}|\bBrainMemory\b)\s*from\s*['"][^'"]+['"]/.test(line);
  const jsStar = /import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*brain-memory[^'"]*['"]/.test(line);
  const jsDyn = /import\s*\(\s*['"][^'"]*brain-memory[^'"]*['"]\s*\)/.test(line);
  const pyFrom = /\bfrom\s+\S*brain[_-]memory\S*\s+import\b/.test(line);
  const pyMod = /\bimport\s+\S*brain[_-]memory\b/.test(line);
  const pyNamed = /\bfrom\s+\S+\s+import\s+[^\n]*\bBrainMemory\b/.test(line);
  return jsNamed || jsStar || jsDyn || pyFrom || pyMod || pyNamed;
}

export function isBrainMemoryConstruct(line: string): boolean {
  return isCodeLine(line) && /\bnew\s+BrainMemory\s*\(/.test(line);
}
