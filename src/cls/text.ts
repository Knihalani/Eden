export const STOP = new Set(
  "the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no hey hi hello yeah yes ok okay thanks thank do does did be been being it it's i'm i've i'd i'll we've we're they're he's she's am were will would could should can just so very really too also there here their them they he she him her his my me we us at by as if than but".split(
    " ",
  ),
);

export function stem(w0: string): string {
  let w = String(w0 ?? "");
  if (w.length < 4 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length >= 6) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length >= 5) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length >= 5) w = w.slice(0, -2);
  else if (w.endsWith("ship") && w.length >= 8) w = w.slice(0, -4);
  else if (w.endsWith("hood") && w.length >= 8) w = w.slice(0, -4);
  if (w.length >= 4 && /([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const NUMWORD: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90" };
const CONTRACT: Record<string, string> = { "i'm": "i", "i've": "i", "i'd": "i", "i'll": "i", "don't": "not", "doesn't": "not", "didn't": "not", "can't": "not", "won't": "not", "isn't": "not", "aren't": "not", "wasn't": "not", "haven't": "not", "hasn't": "not" };

export function contentToks(s: string): string[] {
  const out: string[] = [];
  for (const w0 of (String(s ?? "").toLowerCase().match(/[a-z0-9]+(?:[.'\-][a-z0-9]+)*/g) ?? [])) {
    const w = String(CONTRACT[w0] ?? w0);
    if (STOP.has(w)) continue;
    const base = w.replace(/'s$/, "");
    if (!base || STOP.has(base)) continue;
    if (NUMWORD[base]) {
      out.push(NUMWORD[base]!);
      continue;
    }
    if (base.length < 2) continue;
    out.push(stem(base));
  }
  return out;
}

export function properNames(s: string): string[] {
  const skip = new Set(["are", "the", "what", "when", "why", "how", "who", "where", "this", "that", "these", "those", "can", "could", "would", "will", "did", "does", "has", "have", "had", "but", "not", "and", "for", "you", "your", "please", "thanks", "there"]);
  const out: string[] = [];
  const re = /(?:^|[^A-Za-z])((?:Dr|Mr|Mrs|Ms|St)\.?\s+)?([A-Z][a-z]{2,16})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = m[2]!.toLowerCase();
    if (!skip.has(n)) out.push(n);
  }
  return out;
}

export function codeToks(s: string): string[] {
  return (s.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]{2,12}\b/g) ?? []).map((x) => x.toLowerCase());
}
