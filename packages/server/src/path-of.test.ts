/**
 * D1892: the handler's request parsing without a URL object a request, against what it replaced: `pathOf` and
 * `queryOf` against `new URL` (the same path and query values, and a throw where it throws), `keyOf`'s slice against
 * the regex and trim, `utcDay` against `toISOString`. Fuzzed over the characters the URL parser treats specially.
 */
import { describe, expect, test } from "bun:test";
import { keyOf } from "./auth";
import { pathOf, queryOf, utcDay } from "./http";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIXES = ["http://", "https://", "HTTP://", "http:/", "http:", "ftp://", "file://", "", "http://\t"];
const HOSTS = [
  "127.0.0.1:8790",
  "localhost",
  "a.b",
  "[::1]:80",
  "h:99999",
  "1.2.3.999",
  "a\\b",
  "u@h",
  "h?x",
  "h#y",
  "",
  "h\tx",
  "ex ample",
  "xn--a",
  "a..b",
  "%41",
];
const PIECES = [
  "/",
  "/v1",
  "/events",
  "//",
  "/.",
  "/..",
  "/./",
  "/%2e",
  "%20",
  "\\",
  " ",
  "\t",
  "\n",
  "?",
  "#",
  "&",
  "=",
  "a",
  "Z",
  "0",
  "_",
  "-",
  "~",
  "é",
  "😀",
  "\ud800",
  "waitMs=",
  "500",
  "shadow=1",
  "+",
  "%",
  "%zz",
  "'",
  '"',
  "<",
  "\u0000",
  "\u007f",
];

function url(r: () => number): string {
  let s = PREFIXES[Math.floor(r() * PREFIXES.length)]! + HOSTS[Math.floor(r() * HOSTS.length)]!;
  const n = Math.floor(r() * 10);
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)]!;
  if (r() < 0.3) s += " ";
  return s;
}

function outcome(f: () => unknown): unknown {
  try {
    return { value: f() };
  } catch {
    return "throws";
  }
}

describe("D1892: request parsing without a URL a request", () => {
  test("pathOf and queryOf read what new URL reads, on 30,000 fuzzed URLs and the usual ones", () => {
    const r = rng(1892);
    const urls = [
      "http://127.0.0.1:8790/v1/events?waitMs=500",
      "http://127.0.0.1:8790/v1/events?waitMs=500&shadow=1",
      "http://localhost/v1/ask",
      "https://eden.example.com/v1/pending?shadow=1#x",
      "http://h/v1/../v1/events",
      "http://h/v1/%65vents",
      "http://h\\v1/events",
      "http://h/v1/events#?waitMs=9",
      "http://h/v1/events?wait%4Ds=9",
      "http://h/v1/events?waitMs=9 ",
    ];
    for (let i = 0; i < 30_000; i++) urls.push(url(r));
    let fast = 0;
    for (const u of urls) {
      const want = outcome(() => new URL(u).pathname);
      expect(outcome(() => pathOf(u))).toEqual(want);
      if (want !== "throws") {
        fast++;
        const q = new URL(u).searchParams;
        const got = queryOf(u);
        expect([...got]).toEqual([...q]);
      }
    }
    expect(fast).toBeGreaterThan(5_000);
  });

  test("keyOf reads what the regex and trim read", () => {
    const r = rng(7);
    const parts = [
      "Bearer",
      "bearer",
      "BEARER",
      " ",
      "\u00a0",
      "\t",
      "key-0123",
      "k",
      "",
      "Basic",
      "\u2003",
      "é",
      "x y",
    ];
    const headers: (string | null)[] = [null, "Bearer abc", "Bearer  abc", "Bearer abc ", "Bearer \u00a0", "Bearer "];
    for (let i = 0; i < 20_000; i++) {
      let h = "";
      const n = 1 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) h += parts[Math.floor(r() * parts.length)]!;
      headers.push(h);
    }
    let read = 0;
    for (const h of headers) {
      let req: Request;
      try {
        req = new Request("http://h/v1/events", h === null ? {} : { headers: { authorization: h } });
      } catch {
        continue; // A value no request can carry (a control character).
      }
      read++;
      const want =
        req.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "")
          .trim() ?? "";
      expect(keyOf(req)).toBe(want);
    }
    expect(read).toBeGreaterThan(10_000);
  });

  test("utcDay is toISOString's day, across day ends and in any order", () => {
    const r = rng(11);
    const times = [0, 86_399_999, 86_400_000, Date.UTC(2026, 10, 14, 23, 59, 59, 999), Date.UTC(2026, 10, 15)];
    for (let i = 0; i < 20_000; i++) times.push(Math.floor(r() * 4e12));
    for (let i = 0; i < 2_000; i++)
      times.push(Date.UTC(2026, 0, 1) + Math.floor(r() * 3) * 86_400_000 - 1 + Math.floor(r() * 3));
    for (const t of times) expect(utcDay(t)).toBe(new Date(t).toISOString().slice(0, 10));
    expect(() => utcDay(Number.NaN)).toThrow();
    expect(utcDay(-1)).toBe("1969-12-31");
  });
});
