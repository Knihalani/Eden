/**
 * The independent oracle (D1850, the second review of 2026-11-14): whether the characters the gate keeps and main
 * removed are, as written in the text, a value that cannot be a secret. Written apart from `not-secret.ts`, by hand,
 * without its regexes, and stricter where the two could differ: a loss against main counts only where this agrees.
 */

const TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "undefined",
  "null",
  "unknown",
  "never",
  "void",
  "object",
]);
const GENERICS = new Set([
  "Set",
  "Map",
  "WeakMap",
  "WeakSet",
  "Array",
  "ReadonlyArray",
  "Promise",
  "Record",
  "Partial",
  "Readonly",
]);
const TYPED = new Set([
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Uint8ClampedArray",
]);
const RECEIVERS = new Set([
  "this",
  "process",
  "env",
  "options",
  "opts",
  "config",
  "cfg",
  "settings",
  "req",
  "request",
  "res",
  "response",
  "data",
  "body",
  "usage",
  "ctx",
  "context",
  "args",
  "params",
  "props",
  "state",
  "self",
  "window",
  "globalThis",
]);

const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isLetter = (c: number) => isUpper(c) || isLower(c);
const all = (s: string, ok: (c: number) => boolean) => {
  for (let i = 0; i < s.length; i++) if (!ok(s.charCodeAt(i))) return false;
  return s.length > 0;
};
/** Letters and underscores in one case (the case of its first letter), at least one letter, no digit. */
function name(s: string): boolean {
  let upper = 0;
  let lower = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isUpper(c)) upper++;
    else if (isLower(c)) lower++;
    else if (c !== 95) return false;
  }
  return upper + lower > 0 && (upper === 0 || lower === 0);
}

function typeValue(v: string): boolean {
  let base = v;
  while (base.endsWith("[]")) base = base.slice(0, -2);
  if (TYPES.has(base) || TYPED.has(v)) return true;
  const lt = v.indexOf("<");
  if (lt < 0 || !v.endsWith(">") || !GENERICS.has(v.slice(0, lt))) return false;
  return all(
    v.slice(lt + 1, -1),
    (c) => isLetter(c) || c === 36 || c === 44 || c === 32 || c === 124 || c === 91 || c === 93 || c === 60 || c === 62,
  );
}

function envValue(v: string): boolean {
  for (const head of ["process.env.", "import.meta.env."]) {
    if (v.startsWith(head)) return all(v.slice(head.length), (c) => isUpper(c) || c === 95);
  }
  return false;
}

function memberValue(v: string): boolean {
  const parts = v.replaceAll("?.", ".").split(".");
  if (parts.length < 3 || !RECEIVERS.has(parts[0]!)) return false;
  return parts.slice(1).every((p) => all(p, (c) => isLetter(c) || c === 95 || c === 36));
}

function referenceValue(v: string): boolean {
  if (v.startsWith("${") && v.endsWith("}")) return name(v.slice(2, -1));
  if (v.startsWith("{{") && v.endsWith("}}")) return v.slice(2, -2).split(".").every(name);
  if (v.length > 2 && v.startsWith("%") && v.endsWith("%")) return name(v.slice(1, -1));
  if (v.startsWith("$")) return v.includes("_") && all(v.slice(1), (c) => isUpper(c) || c === 95);
  if (v.startsWith("<") && v.endsWith(">")) {
    const words = v.slice(1, -1).split(/[-_]/);
    return words.every((w) => all(w, isLower)) || words.every((w) => all(w, isUpper));
  }
  return false;
}

/** The value after an optional prefix of 1–8 letters and one of `_~.-` (or none). */
function afterPrefix(v: string, rest: (r: string) => boolean): boolean {
  if (rest(v)) return true;
  for (let i = 1; i <= 8 && i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (!isLetter(v.charCodeAt(i - 1))) return false;
    if ((c === 95 || c === 126 || c === 46 || c === 45) && rest(v.slice(i + 1))) return true;
  }
  return false;
}

function maskValue(v: string): boolean {
  return afterPrefix(
    v,
    (r) => r.length >= 8 && all(r, (c) => c === 120 || c === 88 || c === 42 || c === 0x2022 || c === 35),
  );
}

function runValue(v: string): boolean {
  // Up to two `=` of padding after the run, unless the run is of `=` itself.
  let end = v.length;
  let pad = 0;
  while (pad < 2 && v[end - 1 - pad] === "=") pad++;
  if (pad > 0 && v[end - 1 - pad] !== "=") end -= pad;
  const body = v.slice(0, end);
  // The run is the longest tail of one character; before it, letters only (at most 8) and one separator at most.
  const c = body.charCodeAt(body.length - 1);
  let start = body.length - 1;
  while (start > 0 && body.charCodeAt(start - 1) === c) start--;
  if (body.length - start < 16) return false;
  let head = body.slice(0, start);
  const last = head.charCodeAt(head.length - 1);
  if (last === 95 || last === 126 || last === 46 || last === 45) head = head.slice(0, -1);
  return head.length <= 8 && (head.length === 0 || all(head, isLetter));
}

/** `v` without one pair of quotes around it and the `,;` and unmatched `)]}` after it. */
function trim(v: string): string {
  let t = v;
  for (;;) {
    const last = t[t.length - 1];
    if (last === "," || last === ";" || last === ":") t = t.slice(0, -1);
    else if (last === ")" && count(t, "(") < count(t, ")")) t = t.slice(0, -1);
    else if (last === "]" && count(t, "[") < count(t, "]")) t = t.slice(0, -1);
    else if (last === "}" && count(t, "{") < count(t, "}")) t = t.slice(0, -1);
    else break;
  }
  const q = t[0];
  if (t.length >= 2 && (q === '"' || q === "'" || q === "`") && t[t.length - 1] === q) t = t.slice(1, -1);
  return t;
}
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Whether `value`, as written, cannot be a secret. */
export function oracleNotSecret(value: string): boolean {
  const v = trim(value);
  if (v.length === 0 || v.length > 512) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 32 || c === 34 || c === 39 || c === 96) return false;
  }
  return typeValue(v) || envValue(v) || memberValue(v) || referenceValue(v) || maskValue(v) || runValue(v);
}

/** Characters that end the written value around a lost run, on the left and on the right. */
const LEFT_STOP = new Set([..." \t\n\r=:\"'`,"].map((c) => c.charCodeAt(0)));
const RIGHT_STOP = new Set([..." \t\n\r\"'`,;&"].map((c) => c.charCodeAt(0)));

/**
 * The value around `[start, end)` as written. Inside quotes (the run starts at one, or the value it sits in opens
 * with one) whose closing quote the run reaches, the quoted string; otherwise from the last stop before it to the
 * first stop after it.
 */
export function writtenValue(text: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !LEFT_STOP.has(text.charCodeAt(a - 1))) a--;
  for (const open of [start, a - 1]) {
    const q = text.charCodeAt(open);
    if (open < 0 || !(q === 34 || q === 39 || q === 96)) continue;
    const close = text.indexOf(text[open]!, open + 1);
    // A quote that closes past a space is another value's (`"a and b"` is two tokens to the gate): read as written.
    if (close >= end - 1 && close > open && !/\s/.test(text.slice(open, close))) return text.slice(open, close + 1);
  }
  let b = end;
  while (b < text.length && !RIGHT_STOP.has(text.charCodeAt(b))) b++;
  return text.slice(a, b);
}

/** Punctuation and space around a value, which hold no secret: `,;:&` and spaces. */
const AROUND = new Set([...",;:& \t\n\r"].map((c) => c.charCodeAt(0)));
const QUOTE = new Set([34, 39, 96]);

/**
 * The value a run `[start, end)` of kept characters belongs to, as written (`writtenValue`), or undefined when the
 * run holds nothing but quotes, punctuation and space (a closing quote main took with a value and the gate keeps).
 */
export function keptValue(text: string, start: number, end: number): string | undefined {
  let a = start;
  let b = end;
  while (a < b && AROUND.has(text.charCodeAt(a))) a++;
  while (b > a && AROUND.has(text.charCodeAt(b - 1))) b--;
  let content = false;
  for (let i = a; i < b && !content; i++) content = !QUOTE.has(text.charCodeAt(i));
  return content ? writtenValue(text, a, b) : undefined;
}
