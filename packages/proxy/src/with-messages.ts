/**
 * `raw` (a JSON object's text) with its top-level `messages` value replaced (or `key`'s: the Responses route's
 * `input`), every other byte as it came: parsing and
 * re-serialising the whole body changed fields the proxy never touches (an integer past 2^53, such as a 64-bit
 * `seed`, lost its digits; audit A5). The last `messages` key wins, as in `JSON.parse`. Null when there is none.
 */
export function withMessages(raw: string, messages: unknown, key = "messages"): string | null {
  const quoted = JSON.stringify(key);
  let depth = 0;
  let at: [number, number] | null = null;
  let i = 0;
  const skipString = (k: number): number => {
    for (k++; k < raw.length; k++) {
      if (raw[k] === "\\") k++;
      else if (raw[k] === '"') return k + 1;
    }
    return k;
  };
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && raw.slice(i, end) === quoted) {
        let k = end;
        while (/\s/.test(raw[k] ?? "")) k++;
        if (raw[k] === ":") {
          k++;
          while (/\s/.test(raw[k] ?? "")) k++;
          const start = k;
          // The value: a string, or a run up to the next comma or brace at this depth.
          let d = 0;
          while (k < raw.length) {
            const v = raw[k]!;
            if (v === '"') {
              k = skipString(k);
              continue;
            }
            if (v === "[" || v === "{") d++;
            else if (v === "]" || v === "}") {
              if (d === 0) break;
              d--;
            } else if (v === "," && d === 0) break;
            k++;
          }
          let stop = k;
          while (stop > start && /\s/.test(raw[stop - 1]!)) stop--;
          at = [start, stop];
          i = k;
          continue;
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return at ? raw.slice(0, at[0]) + JSON.stringify(messages) + raw.slice(at[1]) : null;
}
