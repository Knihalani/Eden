/**
 * Realistic text for the gate's benchmarks and its differential test against the reference gate: the sim world's
 * items by kind (mail, chat, docs, notifications), the eval scenarios' texts, the repo's own TypeScript, generated
 * service logs and JSON tool results, each cut to a size. Deterministic: the same call returns the same texts.
 * Not product code (it imports the sim, which nothing in the product does).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildWorld } from "../../sim/src/world.ts";

const ROOT = join(import.meta.dir, "../../..");

/** mulberry32. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Kind = "mail" | "chat" | "doc" | "eval" | "code" | "log" | "json";
export const KINDS: Kind[] = ["mail", "chat", "doc", "eval", "code", "log", "json"];

let worldTexts: Record<"mail" | "chat" | "doc", string[]> | undefined;
function world(): Record<"mail" | "chat" | "doc", string[]> {
  if (worldTexts) return worldTexts;
  const out: Record<"mail" | "chat" | "doc", string[]> = { mail: [], chat: [], doc: [] };
  for (const seed of [41, 42]) {
    for (const item of buildWorld({ seed }).items) {
      const text = `${item.title}\n${item.text}`;
      const kind = item.kind === "mail" || item.kind === "newsletter" || item.kind === "promo" ? "mail" : item.kind;
      if (kind === "chat") out.chat.push(text);
      else if (kind === "mail") out.mail.push(text);
      else out.doc.push(text);
    }
  }
  worldTexts = out;
  return out;
}

/** Every string under a `text`, `title` or `description` key of the eval scenarios. */
let evalTexts: string[] | undefined;
function scenarios(): string[] {
  if (evalTexts) return evalTexts;
  const out: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (key === "text" || key === "title" || key === "description") out.push(value);
    } else if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  const dirs = [join(ROOT, "packages/eval/scenarios"), join(ROOT, "packages/eval/scenarios/acting")];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".json")) walk(JSON.parse(readFileSync(join(dir, name), "utf8")), "");
    }
  }
  evalTexts = out;
  return out;
}

let codeTexts: string[] | undefined;
function code(): string[] {
  if (codeTexts) return codeTexts;
  const out: string[] = [];
  for (const pkg of ["engine", "server", "sources", "primitives", "graph", "llm", "client", "proxy"]) {
    const dir = join(ROOT, "packages", pkg, "src");
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (name.endsWith(".ts") && statSync(path).isFile()) out.push(readFileSync(path, "utf8"));
    }
  }
  codeTexts = out;
  return out;
}

const LEVELS = ["INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"];
const ROUTES = ["/v1/observe", "/v1/ask", "/healthz", "/v1/sources/sync", "/v1/items/42f1", "/metrics"];
const MSGS = [
  "request completed",
  "upstream timeout after 2000ms, retrying",
  "cache miss for user u_8231 source gmail",
  "token bucket refilled for tenant acme",
  "connected to postgres at db.internal:5432",
  "auth ok for session s_19ab via api key header",
  "slow query: SELECT * FROM items WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
  "worker 3 exited with code 0",
];
function log(rnd: () => number, bytes: number): string {
  let out = "";
  let t = Date.UTC(2026, 10, 14, 9, 0, 0);
  while (out.length < bytes) {
    t += Math.floor(rnd() * 900);
    const level = LEVELS[Math.floor(rnd() * LEVELS.length)]!;
    const route = ROUTES[Math.floor(rnd() * ROUTES.length)]!;
    const msg = MSGS[Math.floor(rnd() * MSGS.length)]!;
    const id = Math.floor(rnd() * 2 ** 32).toString(16);
    out += `${new Date(t).toISOString()} ${level} [req=${id}] ${route} ${msg} ms=${Math.floor(rnd() * 400)}\n`;
  }
  return out;
}

function json(rnd: () => number, bytes: number): string {
  const items = world().mail.concat(world().doc);
  const results: unknown[] = [];
  let size = 0;
  while (size < bytes) {
    const text = items[Math.floor(rnd() * items.length)]!;
    const row = {
      id: `msg_${Math.floor(rnd() * 1e9).toString(36)}`,
      threadId: Math.floor(rnd() * 1e12).toString(16),
      snippet: text.slice(0, 200),
      body: text,
      labels: ["INBOX", "IMPORTANT"],
      internalDate: String(Date.UTC(2026, 9, 1) + Math.floor(rnd() * 1e9)),
    };
    results.push(row);
    size += JSON.stringify(row).length;
  }
  return JSON.stringify({ messages: results, nextPageToken: null });
}

/** One text of `kind` of about `bytes` characters (pieces joined by blank lines, then cut), from `seed`. */
export function sample(kind: Kind, bytes: number, seed = 1): string {
  const rnd = prng(seed * 7919 + bytes);
  if (kind === "log") return log(rnd, bytes).slice(0, bytes);
  if (kind === "json") return json(rnd, bytes).slice(0, bytes);
  const pool = kind === "eval" ? scenarios() : kind === "code" ? code() : world()[kind];
  let out = "";
  while (out.length < bytes) out += (out ? "\n\n" : "") + pool[Math.floor(rnd() * pool.length)]!;
  return out.slice(0, bytes);
}

/** Every whole piece of every kind (items, scenario texts, files), for differential checks. */
export function pieces(): { kind: Kind; text: string }[] {
  const out: { kind: Kind; text: string }[] = [];
  for (const kind of ["mail", "chat", "doc"] as const) for (const text of world()[kind]) out.push({ kind, text });
  for (const text of scenarios()) out.push({ kind: "eval", text });
  for (const text of code()) out.push({ kind: "code", text });
  return out;
}
