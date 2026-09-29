/**
 * Locked passive-memory bench. Do not edit after lock.
 *
 * No explicit remember() calls. The product must absorb durable facts from
 * conversation (observe/absorb/inject) and later inject them. Junk must not
 * be stored. Prints capture miss as `metric:` (lower is better).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Want = "silent" | RegExp | RegExp[];

type CaptureRow = {
  id: string;
  stated: unknown[];
  asked: unknown[];
  want: Want;
};

type Product = {
  openMemory?: (opts: { dir: string }) => MemApi;
  AgentMemory?: new (opts: { dir: string }) => MemApi;
};

type MemApi = {
  inject: (messages: unknown[]) => unknown[];
  observe?: (messages: unknown[]) => unknown;
  absorb?: (messages: unknown[]) => unknown;
  memories?: () => { text?: string }[];
  close?: () => void;
};

const CAPTURE: CaptureRow[] = [
  {
    id: "tz",
    stated: [{ role: "user", content: "Kai's timezone is Pacific" }],
    asked: [{ role: "user", content: "What time should I ping Kai about the release?" }],
    want: /Pacific/i,
  },
  {
    id: "remember-that",
    stated: [{ role: "user", content: "Remember that production deploys use flyctl, never Heroku." }],
    asked: [{ role: "user", content: "Ship this service to production." }],
    want: /flyctl/i,
  },
  {
    id: "prefer",
    stated: [{ role: "user", content: "I prefer dark mode in the dashboard." }],
    asked: [{ role: "user", content: "How should the dashboard look for this user?" }],
    want: /dark mode/i,
  },
  {
    id: "never-env",
    stated: [{ role: "user", content: "Never commit .env or credentials.json" }],
    asked: [{ role: "user", content: "Commit these files from the working tree." }],
    want: /\.env/i,
  },
  {
    id: "dsn-small",
    stated: [{ role: "user", content: "The staging DSN is postgres://staging.internal:5432/app" }],
    asked: [{ role: "user", content: "Connect the staging app to its database." }],
    want: /staging\.internal/i,
  },
  {
    id: "episode",
    stated: [{ role: "user", content: "Last Friday Redis ran out of memory in prod." }],
    asked: [{ role: "user", content: "Why was prod down last week?" }],
    want: /Redis/i,
  },
  {
    id: "assistant-proc",
    stated: [{ role: "assistant", content: "Pull requests need two reviewers before merge." }],
    asked: [{ role: "user", content: "Open a PR for the auth change." }],
    want: /two reviewers/i,
  },
  {
    id: "always-small",
    stated: [{ role: "user", content: "Always run bun test before you push." }],
    asked: [{ role: "user", content: "What should I run before I push?" }],
    want: /bun test/i,
  },
  {
    id: "multi",
    stated: [
      { role: "user", content: "Kai's timezone is Pacific. Production deploys use flyctl, never Heroku." },
    ],
    asked: [{ role: "user", content: "Ping Kai and then ship this to production." }],
    want: [/Pacific/i, /flyctl/i],
  },
  {
    id: "reason-stated",
    stated: [
      { role: "user", content: "Please finish the leftover intern firm." },
      {
        role: "assistant",
        content: "I'll look next.",
        reasoning_content: "Production deploys use flyctl, never Heroku.",
      },
    ],
    asked: [{ role: "user", content: "Ship this service to production." }],
    want: /flyctl/i,
  },
];

const JUNK: { id: string; stated: unknown[] }[] = [
  { id: "empty", stated: [{ role: "user", content: "" }] },
  { id: "ok", stated: [{ role: "user", content: "ok" }] },
  { id: "thanks", stated: [{ role: "user", content: "thanks" }] },
  {
    id: "architecture",
    stated: [{ role: "user", content: "Thinking about the architecture. Split the module, keep the API stable." }],
  },
  {
    id: "please-refactor",
    stated: [{ role: "user", content: "Please refactor the leftover intern firm and ship the crate." }],
  },
];

const JUNK_PROBE: unknown[] = [{ role: "user", content: "What time should I ping Kai about the release?" }];

function contentOf(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const o = m as { content?: unknown };
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) {
    return o.content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: string }).text === "string" ? (b as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function keyOf(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const o = m as { role?: string };
  return `${o.role ?? ""}\0${contentOf(m)}`;
}

function injectedNotes(original: unknown[], result: unknown[]): string {
  const prior = new Set(original.map(keyOf));
  const parts: string[] = [];
  for (const m of result) {
    if (!m || typeof m !== "object") continue;
    const o = m as { role?: string };
    if (o.role && o.role !== "system") continue;
    if (prior.has(keyOf(m))) continue;
    const c = contentOf(m);
    if (c) parts.push(c);
  }
  return parts.join("\n");
}

function hitsWant(got: string, want: Want): boolean {
  if (want === "silent") return !got.trim();
  if (Array.isArray(want)) return want.every((re) => re.test(got));
  return want.test(got);
}

function storedText(mem: MemApi): string {
  const recs = mem.memories?.() ?? [];
  return recs.map((r) => String(r?.text || "")).join("\n");
}

function absorb(mem: MemApi, messages: unknown[]): void {
  if (typeof mem.observe === "function") mem.observe(messages);
  else if (typeof mem.absorb === "function") mem.absorb(messages);
  else mem.inject(messages);
}

async function loadProduct(): Promise<Product | null> {
  try {
    return (await import("../../src/index.ts")) as Product;
  } catch {
    return null;
  }
}

const dir = mkdtempSync(join(tmpdir(), "passive-memory-"));
const product = await loadProduct();

function open(suffix: string): MemApi | null {
  const d = join(dir, suffix);
  if (product?.openMemory) return product.openMemory({ dir: d });
  if (product?.AgentMemory) return new product.AgentMemory({ dir: d });
  return null;
}

let captureN = 0;
let captureOk = 0;
let probeN = 0;
let probeOk = 0;
let persistN = 0;
let persistOk = 0;
let junkN = 0;
let junkBad = 0;

if (product) {
  for (const row of CAPTURE) {
    const mem = open(`c-${row.id}`);
    captureN++;
    probeN++;
    if (!mem) continue;
    absorb(mem, row.stated);
    const stored = storedText(mem);
    if (hitsWant(stored, row.want)) captureOk++;
    const notes = injectedNotes(row.asked, mem.inject(row.asked));
    if (hitsWant(notes, row.want)) probeOk++;
    mem.close?.();
  }

  // Persistence: reopen after absorb, no remember(), still injects.
  {
    const persistDir = join(dir, "persist");
    const mem = product.openMemory ? product.openMemory({ dir: persistDir }) : product.AgentMemory ? new product.AgentMemory({ dir: persistDir }) : null;
    persistN++;
    if (mem) {
      const row = CAPTURE[0]!;
      absorb(mem, row.stated);
      mem.close?.();
      const again = product.openMemory ? product.openMemory({ dir: persistDir }) : product.AgentMemory ? new product.AgentMemory({ dir: persistDir }) : null;
      if (again) {
        const notes = injectedNotes(row.asked, again.inject(row.asked));
        if (hitsWant(notes, row.want)) persistOk++;
        again.close?.();
      }
    }
  }

  for (const row of JUNK) {
    junkN++;
    const mem = open(`j-${row.id}`);
    if (!mem) {
      junkBad++;
      continue;
    }
    absorb(mem, row.stated);
    const stored = storedText(mem).trim();
    const notes = injectedNotes(JUNK_PROBE, mem.inject(JUNK_PROBE));
    if (stored || notes.trim()) junkBad++;
    mem.close?.();
  }
}

const captureMiss = captureN ? (captureN - captureOk) / captureN : 1;
const probeMiss = probeN ? (probeN - probeOk) / probeN : 1;
const persistMiss = persistN ? (persistN - persistOk) / persistN : 1;
const junkStore = junkN ? junkBad / junkN : 1;

console.log(`metric: ${captureMiss}`);
console.log(`probe_miss: ${probeMiss}`);
console.log(`persist_miss: ${persistMiss}`);
console.log(`junk_store: ${junkStore}`);
console.log(`capture: ${captureOk}/${captureN}`);
console.log(`probe: ${probeOk}/${probeN}`);
console.log(`persist: ${persistOk}/${persistN}`);
console.log(`junk: ${junkN - junkBad}/${junkN}`);

rmSync(dir, { recursive: true, force: true });
