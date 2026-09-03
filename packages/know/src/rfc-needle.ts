/** RFC nnnn scan with no synth / query imports — wrap’s first hit stays off rfc-titles.bin until pack. */

function isTokStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isTokChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 43 ||
    c === 46 ||
    c === 45
  );
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function skipSpace(slice: string, i: number, n: number): number {
  while (i < n && slice.charCodeAt(i) <= 32) i++;
  return i;
}

function gluedRfcAt(slice: string, i: number, n: number): string | undefined {
  const max = Math.min(n, i + 8);
  const wLen = max - i;
  if (wLen < 4) return;
  const c0 = slice.charCodeAt(i);
  const c1 = slice.charCodeAt(i + 1);
  const c2 = slice.charCodeAt(i + 2);
  if ((c0 !== 82 && c0 !== 114) || (c1 !== 70 && c1 !== 102) || (c2 !== 67 && c2 !== 99)) return;
  let d = i + 3;
  while (d < max && isDigit(slice.charCodeAt(d))) d++;
  const dn = d - (i + 3);
  if (dn < 1 || dn > 5) return;
  const next = d < n ? slice.charCodeAt(d) : 0;
  if (isDigit(next) || isTokStart(next)) return;
  return slice.slice(i + 3, d);
}

/** First RFC nnnn in prompt order. Inject flash-hits this without a full needle scan or pack stat. */
export function firstRfcNeedle(text: string): string | undefined {
  const slice = text.length > 6_000 ? text.slice(0, 6_000) : text;
  const n = slice.length;
  if (n < 5) return;
  let from = 0;
  while (from < n) {
    let i = slice.indexOf("RFC", from);
    const j = slice.indexOf("rfc", from);
    if (i < 0 || (j >= 0 && j < i)) i = j;
    if (i < 0) return;
    if (i > 0 && isTokChar(slice.charCodeAt(i - 1))) {
      from = i + 1;
      continue;
    }
    const glued = gluedRfcAt(slice, i, n);
    if (glued) return `RFC ${glued}`;
    let k = skipSpace(slice, i + 3, n);
    let d = k;
    while (d < n && isDigit(slice.charCodeAt(d))) d++;
    const dn = d - k;
    if (dn >= 1 && dn <= 5) {
      const next = d < n ? slice.charCodeAt(d) : 0;
      if (!isDigit(next) && !isTokStart(next)) return `RFC ${slice.slice(k, d)}`;
    }
    from = i + 1;
  }
  return;
}
