/**
 * M8.4 labeled packet. notesFor format: [rule] / [fact] / [episode] / [gist].
 * retrieveText must not rewrite rules. k default 6–10. Fail-open.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKET_SOFT_BULLETS } from "./memory-hook-packet";
import { PACKET_BYTE_CAP } from "./memory-sota";
import { GistStore } from "./gist-store";
import { HowToStore } from "./howto-store";
import {
  applyProvenanceLabel,
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_CHAR_CAP,
  EXPERIENCE_SLICE_TOKEN_CAP,
  FACT_CHAR_CAP,
  MEMORY_MARK,
  logMemoryNotes,
  memoryInjectSwallows,
  memoryLogEnabled,
  memoryRetrieveCap,
  openMemory,
  PACKET_CHAT_K_DEFAULT,
  PACKET_CHAT_K_MAX,
  PACKET_CHAT_K_MIN,
  PROCEDURE_CHAR_CAP,
  PROCEDURE_TOKEN_CAP,
  relativeMemoryAge,
  sleep,
  type AgentMemory,
  injectedPackets,
} from "./index";
import { memoryHookResponse } from "../packages/cli/src/memory-hook";
import { withKnowFactsAnthropic } from "../packages/wrap/src/know-inject";
import * as edenMem from "./index";
import { storeFor } from "./memory-repo";

const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

const RULE = "Always run tests before committing";
const FACT = "auth.provider = Clerk  (as of 2026-09-10)";
const EPISODE = "2026-09-16 User: the flake is in src/auth.test.ts";
const GIST = "This repo’s CI is GitHub Actions; Node 18";
const NEVER_LOG = "Never console.log in production";
const PACKET_CUE = "Clerk auth.provider tests committing flake src/auth.test.ts GitHub Actions";

function tmpDir(prefix = "eden-m84-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withMem(fn: (mem: AgentMemory, dir: string) => void): void {
  const dir = tmpDir();
  try {
    fn(openMemory({ dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A store at the hook's place for this process's repo (D1: a payload without `cwd` is keyed by `process.cwd()`). */
async function withMemAsync<T>(
  prefix: string,
  fn: (mem: AgentMemory, dir: string) => T | Promise<T>,
  session?: string,
): Promise<T> {
  const root = tmpDir(prefix);
  const dir = storeFor(root);
  return withEnv({ EDEN_MEMORY_DIR: root, EDEN_HOME: undefined, EDEN_MEMORY_CAP: undefined }, async () => {
    try {
      const mem = openMemory({ dir, session, perRepo: true });
      return await fn(mem, dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function packetOf(messages: unknown[]): string {
  return injectedPackets(messages).join("\n");
}

function hookContext(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const spec = raw.hookSpecificOutput;
  const extra = spec && typeof spec === "object" ? (spec as { additionalContext?: unknown }).additionalContext : "";
  return [raw.additional_context, extra].map((x) => String(x ?? "")).join("\n");
}

function defaultNotesForK(): number {
  if (/notesFor\(text = "", k = memoryRetrieveCap\(\)/.test(INDEX_SRC)) return memoryRetrieveCap();
  const literal = INDEX_SRC.match(/notesFor\(text = "", k = Number\(process\.env\.EDEN_MEMORY_CAP\) \|\| (\d+)/);
  if (literal) return Number(literal[1]);
  if (/notesFor\(text = "", k = Number\(process\.env\.EDEN_MEMORY_CAP\) \|\| PACKET_CHAT_K_DEFAULT/.test(INDEX_SRC)) {
    return PACKET_CHAT_K_DEFAULT;
  }
  return Number.NaN;
}

function factCharCap(): number {
  const literal = INDEX_SRC.match(/const FACT_CHAR_CAP = (\d+)/);
  if (literal) return Number(literal[1]);
  if (/const FACT_CHAR_CAP = PROCEDURE_CHAR_CAP/.test(INDEX_SRC)) return FACT_CHAR_CAP;
  return Number.NaN;
}

/** `[fact]` today, `[fact · 0m · user]` after M40.1. Optional · segments, still one bracket. */
function kindLabel(kind: string): string {
  return `\\[${kind}(?:\\s*·[^\\]]*)?\\]`;
}

function kindPrefix(kind: string): RegExp {
  return new RegExp(`^${kindLabel(kind)}\\s+`);
}

/**
 * Since P0.7 the wrap words a packet as the hook does (D14, `memory-hook-packet.ts`): no `[kind · age · src]` tag,
 * the row's text and its age; a row with no recorded source claims none (A6 §2.1).
 */
const KIND_TAG = /\[(?:rule|fact|episode|gist|procedure)\b[^\]]*\]/;

function worded(text: string): RegExp {
  const source = "(?:you said|from a tool result|earlier session notes), ";
  return new RegExp(`^- ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.? \\((?:${source})?just now\\)$`);
}

function notDoublePrefixed(kind: string, text: string): void {
  expect(text).not.toMatch(new RegExp(`\\[${kind}(?:\\s*·[^\\]]*)?\\]\\s+\\[${kind}\\b`));
}

/** Relative age inside a provenance bracket: 0m / Nm / Nh / Nd / Nw. */
const REL_AGE = /\d+[mhdw]/;
/** Label growth vs `[fact] ` so M20 body caps still hold after `[fact · 59m · sleep]`. */
const PROVENANCE_SLACK = " · 59m · sleep".length;

describe("M8.4 labeled inject packet", () => {
  test("inject packet has the packet header, then a rule, a fact and an episode in D14's words", () => {
    withMem((mem) => {
      mem.remember(RULE, { kind: "constraint" });
      mem.remember(FACT, { kind: "fact" });
      mem.remember(EPISODE, { kind: "episode" });
      const pkt = packetOf(mem.inject([{ role: "user", content: PACKET_CUE }]));
      const bullets = pkt.split("\n").filter((l) => l.startsWith("- "));
      expect(pkt.startsWith(MEMORY_MARK)).toBe(true);
      const ruleLine = bullets.find((l) => l.includes(RULE)) ?? "";
      const factLine = bullets.find((l) => l.includes(FACT)) ?? "";
      const episodeLine = bullets.find((l) => l.includes(EPISODE)) ?? "";
      expect(ruleLine).toMatch(worded(RULE));
      expect(factLine).toMatch(worded(FACT));
      expect(episodeLine).toMatch(worded(EPISODE));
      expect(pkt).not.toMatch(KIND_TAG);
      expect(MEMORY_MARK).toBe("Eden memory, recalled from earlier sessions:");
      expect(bullets).toHaveLength(3);
    });
  });

  test("preference is labeled [fact]; already-labeled text is not double-prefixed", () => {
    withMem((mem) => {
      mem.remember("Kai prefers dark mode in the editor chrome", { kind: "preference" });
      mem.remember("[fact] already labeled Clerk provider", { kind: "fact" });
      const notes = mem.notesFor("Clerk dark mode editor chrome provider");
      const pref = notes.find((r) => /dark mode/i.test(r.text));
      const labeled = notes.find((r) => /already labeled Clerk/i.test(r.text));
      expect(pref?.text).toMatch(/^\[fact(?:\s*·[^\]]*)?\]\s+Kai prefers dark mode in the editor chrome$/);
      expect(labeled?.text).toMatch(/^\[fact(?:\s*·[^\]]*)?\]\s+already labeled Clerk provider$/);
      notDoublePrefixed("fact", labeled?.text ?? "");
    });
  });

  test("hop-chain inject delivers the winner, worded (D14), and never the loser", () => {
    withMem((mem) => {
      mem.remember("1. The chairperson of the committee is Alice.");
      mem.remember("8. The chairperson of the committee is Bob.");
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson of the committee" }]));
      const first = pkt.split("\n").find((l) => l.startsWith("- ")) ?? "";
      expect(pkt).toMatch(/Bob/);
      expect(pkt).not.toMatch(/Alice/);
      expect(first).toMatch(worded("8. The chairperson of the committee is Bob."));
      const body = mem.injectBody({ messages: [{ role: "user", content: "who is the chairperson of the committee" }] });
      const bodyPkt = packetOf(body.messages as unknown[]);
      expect(bodyPkt).toMatch(/Bob/);
      expect(bodyPkt).not.toMatch(/Alice|\[fact/);
    });
  });

  test("procedure kind is labeled [procedure] (M12) in notesFor, and worded in the packet (D14)", () => {
    withMem((mem) => {
      mem.remember("fix failing auth test → tests/auth/session.test.ts", { kind: "procedure" });
      // A cue that restated the procedure would be its own residual (D26), so this one names only its file.
      const pkt = packetOf(mem.inject([{ role: "user", content: "session.test.ts is red in CI" }]));
      expect(pkt.split("\n")).toContainEqual(
        expect.stringMatching(worded("fix failing auth test → tests/auth/session.test.ts")),
      );
      const hit = mem.notesFor("fix failing auth test session.test.ts").find((r) => /session\.test\.ts/.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(kindPrefix("procedure"));
    });
  });
});

describe("M8.4 retrieveText does not rewrite rules", () => {
  test("Never console.log in production stays verbatim (no never no, no Never 0)", () => {
    withMem((mem) => {
      mem.remember(NEVER_LOG, { kind: "constraint" });
      const stored = mem.memories().find((r) => /console\.log/i.test(r.text));
      expect(stored?.text).toBe(NEVER_LOG);
      // D18: a keyed rule (D9 keys this one on `deploy`) comes by its class's trigger, never by word overlap.
      const hit = mem
        .recall([{ role: "user", content: "add console.log output to the production build" }])
        .find((r) => /console\.log/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(
        new RegExp(`^${kindLabel("rule")}\\s+${NEVER_LOG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
      expect(hit!.text).not.toMatch(/never no/i);
      expect(hit!.text).not.toMatch(/Never 0/);
      expect(hit!.text).not.toMatch(/Never no/);
      // D26: a cue restating the rule is its own residual; this one shares its subject only.
      const pkt = packetOf(mem.inject([{ role: "user", content: "add debug output to the production build" }]));
      expect(pkt.split("\n")).toContainEqual(expect.stringMatching(worded(NEVER_LOG)));
      expect(pkt).not.toMatch(/never no/i);
      expect(pkt).not.toMatch(/Never 0/);
    });
  });

  test("constraint without cues still skips retrieveText never→no", () => {
    withMem((mem) => {
      const body = "Production changelog never ships a silent never.";
      mem.remember(body, { kind: "constraint" });
      // D18: keyed on `integrate` ("ships"), it comes by that class's trigger.
      const hit = mem
        .recall([{ role: "user", content: "ship the production changelog" }])
        .find((r) => /changelog/i.test(r.text));
      expect(hit?.text).toMatch(new RegExp(`^${kindLabel("rule")}\\s+${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      expect(hit?.text).not.toMatch(/never no/i);
    });
  });
});

describe("M8.4 episode kind", () => {
  test("episode kind is labeled [episode] in notesFor, and worded in the packet (D14)", () => {
    withMem((mem) => {
      mem.remember(EPISODE, { kind: "episode" });
      const hit = mem.notesFor("the flake is in src/auth.test.ts").find((r) => /auth\.test\.ts/.test(r.text));
      expect(hit?.kind).toBe("episode");
      expect(hit?.text).toMatch(
        new RegExp(`^${kindLabel("episode")}\\s+${EPISODE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
      const pkt = packetOf(mem.inject([{ role: "user", content: "src/auth.test.ts failed again on main" }]));
      expect(pkt.split("\n")).toContainEqual(expect.stringMatching(worded(EPISODE)));
    });
  });
});

describe("M8.4 gist + empty cue", () => {
  test("after sleep, SessionStart has the gist; notesFor labels its kinds; empty cue does not dump last-k", async () => {
    const session = "s-m84-gist";
    await withMemAsync(
      "eden-m84-gist-",
      async (mem, dir) => {
        mem.remember(RULE, { kind: "constraint" });
        mem.remember(FACT, { kind: "fact" });
        mem.remember(GIST, { kind: "gist" });
        mem.quiet(() => {
          mem.remember("CI is GitHub Actions");
          mem.remember("Auth is Clerk");
          mem.remember("The deploy region is us-east-1");
          mem.remember("Kai timezone is Pacific");
          mem.remember("The cache is Redis");
          mem.remember("The queue is SQS");
          mem.remember("Node version is 18");
        });
        await sleep({ dir, mem, session });
        const gists = new GistStore(dir).latest(session, 5);
        expect(gists.length).toBeGreaterThan(0);

        const start = memoryHookResponse({ hook_event_name: "SessionStart", session_id: session });
        const ctx = hookContext(start);
        expect(ctx).toContain(MEMORY_MARK);
        // The hook words its bullets (D14): a rule the user set, a gist from a summary, no [kind · age · src] tag.
        // A pinned rule with no recorded source is a plain bullet: no "Rule you set" (A6 §2.1).
        expect(ctx).toContain(`- ${RULE}`);
        expect(ctx).not.toMatch(/Rule you set/);
        expect(ctx).toContain(`- ${gists[0]!.text} (earlier session notes`);
        expect(ctx).not.toMatch(/\[(?:rule|gist|fact|episode|procedure)\b/);

        // D18: the keyed rule comes by its class's trigger ("committing"), the other kinds by the lexical path.
        const notes = mem.recall([{ role: "user", content: PACKET_CUE }]);
        expect(notes.some((r) => kindPrefix("rule").test(r.text) && r.text.includes(RULE))).toBe(true);
        expect(notes.some((r) => kindPrefix("fact").test(r.text) && /Clerk/.test(r.text))).toBe(true);
        const gistHit = notes.find((r) => r.kind === "gist" || /GitHub Actions; Node 18/.test(r.text));
        if (gistHit) expect(gistHit.text).toMatch(kindPrefix("gist"));

        const empty = packetOf(mem.inject([{ role: "assistant", content: "working" }]));
        expect(empty).not.toMatch(/Clerk/);
        expect(empty).not.toMatch(/Always run tests/);
        expect(empty).not.toContain(MEMORY_MARK);
      },
      session,
    );
  });
});

describe("M8.4 k default 6–10", () => {
  test("notesFor default k is 6–10 and packet length ≤ k", async () => {
    const k = defaultNotesForK();
    expect(k).toBeGreaterThanOrEqual(6);
    expect(k).toBeLessThanOrEqual(10);
    await withEnv({ EDEN_MEMORY_CAP: undefined }, () => {
      withMem((mem) => {
        mem.quiet(() => {
          for (let n = 1; n <= 20; n++) {
            mem.remember(`Widget slot ${n} belongs to the alpha catalog.`);
          }
        });
        const notes = mem.notesFor("alpha catalog");
        expect(notes.length).toBeLessThanOrEqual(k);
        expect(notes.length).toBeLessThanOrEqual(10);
        const pkt = packetOf(mem.inject([{ role: "user", content: "alpha catalog" }]));
        const bullets = pkt.split("\n").filter((l) => l.startsWith("- "));
        // The packet keeps D28's shape (since P0.7 the wrap's too): at most 4 bullets of the k retrieved.
        expect(bullets.length).toBe(Math.min(notes.length, PACKET_SOFT_BULLETS));
      });
    });
  });
});

describe("M8.4 fail-open", () => {
  test("inject: notesFor throw → original messages identity, swallows +1", () => {
    withMem((mem) => {
      const list = [{ role: "user", content: "What GitHub Actions CI do we use?" }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m8.4 inject notesFor");
      }) as typeof mem.notesFor;
      let out: unknown;
      expect(() => {
        out = mem.inject(list);
      }).not.toThrow();
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "What GitHub Actions CI do we use?" }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    });
  });
});

describe("M20.3 packet size bound", () => {
  const FACT_CAP = factCharCap();
  const FACT_LINE_MAX = FACT_CAP + "[fact] ".length + "- ".length + PROVENANCE_SLACK;

  test("huge fact is labeled [fact] and bounded in notesFor; the packet skips it whole (D28); Clerk stays full", () => {
    expect(FACT_CAP).toBeGreaterThan(0);
    expect(FACT_CAP).toBeLessThanOrEqual(1200);
    const k = defaultNotesForK();
    const huge = "The widget catalog is " + "x".repeat(4_000);
    expect(huge.length).toBeGreaterThan(FACT_CAP);
    expect(huge.length).toBeLessThan(262_000);
    withMem((mem) => {
      mem.remember(huge, { kind: "fact" });
      mem.remember(FACT, { kind: "fact" });

      const notes = mem.notesFor("widget catalog");
      const hit = notes.find((r) => /widget catalog/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(kindPrefix("fact"));
      notDoublePrefixed("fact", hit!.text);
      expect(hit!.text.length).toBeLessThanOrEqual(FACT_LINE_MAX);
      expect(hit!.text.length).toBeLessThan(10_000);
      expect(hit!.text).not.toContain("x".repeat(FACT_CAP + 1));

      const clerk = mem.notesFor("Clerk auth.provider").find((r) => /Clerk/.test(r.text));
      expect(clerk?.text).toMatch(
        new RegExp(`^${kindLabel("fact")}\\s+${FACT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );

      // D28 (the hook's packet, the wrap's since P0.7): a bullet that does not fit 900 bytes is skipped, never cut.
      const pkt = packetOf(mem.inject([{ role: "user", content: "widget catalog" }]));
      expect(pkt).not.toMatch(/widget catalog/i);
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
      expect(packetOf(mem.inject([{ role: "user", content: "which auth.provider do we use" }]))).toContain(
        "auth.provider = Clerk  (as of 2026-09-10)",
      );

      mem.quiet(() => {
        for (let n = 1; n <= 20; n++) mem.remember(`Widget slot ${n} belongs to the alpha catalog.`);
      });
      const crowded = packetOf(mem.inject([{ role: "user", content: "alpha catalog" }]));
      const crowdedBullets = crowded.split("\n").filter((l) => l.startsWith("- "));
      expect(crowdedBullets.length).toBeLessThanOrEqual(PACKET_SOFT_BULLETS);
      expect(crowdedBullets.length).toBeLessThanOrEqual(k);
    });
  });

  test("already-labeled huge [fact] is not double-prefixed and body is still capped; the packet skips it (D28)", () => {
    const huge = "[fact] The widget catalog is " + "x".repeat(4_000);
    withMem((mem) => {
      mem.remember(huge, { kind: "fact" });
      const hit = mem.notesFor("widget catalog").find((r) => /widget catalog/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(kindPrefix("fact"));
      notDoublePrefixed("fact", hit!.text);
      expect(hit!.text.length).toBeLessThanOrEqual(FACT_LINE_MAX);
      const pkt = packetOf(mem.inject([{ role: "user", content: "widget catalog" }]));
      expect(pkt).not.toMatch(/widget catalog|\[fact/i);
    });
  });

  test("ICL exemplar is not truncated; label: stays; past 900 bytes the packet skips it whole (D28)", () => {
    const padding = "word ".repeat(400);
    const icl = `The movie was great. ${padding}label: 28`;
    expect(icl.length).toBeGreaterThan(FACT_CAP);
    withMem((mem) => {
      mem.remember(icl, { kind: "fact", lane: "icl" });
      const notes = mem.notesFor("The movie was great. label: 28");
      const hit = notes.find((r) => /movie was great/i.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(/label:\s*28/);
      expect(hit!.text.length).toBeGreaterThan(FACT_CAP);
      const pkt = packetOf(mem.inject([{ role: "user", content: "The movie was great. label: 28" }]));
      expect(pkt).not.toMatch(/movie was great/);
    });
  });

  test("numbered fact list is not capped before assemble; serial 8 survives [fact] relabel in notesFor", () => {
    const list = `1. Remember this padding ${"x".repeat(2_000)}\n8. The chairperson of the committee is Bob.`;
    expect(list.length).toBeGreaterThan(FACT_CAP);
    withMem((mem) => {
      mem.remember(list, { kind: "fact" });
      const notes = mem.notesFor("who is the chairperson");
      expect(notes.some((r) => /8[.)]\s+The chairperson[\s\S]*Bob/i.test(r.text) || /Bob/.test(r.text))).toBe(true);
      expect(notes.some((r) => /\[fact(?:\s*·[^\]]*)?\]\s+\[fact\b/.test(r.text))).toBe(false);
      // The assembled list is past 900 bytes: D28 skips it whole rather than cut it.
      const pkt = packetOf(mem.inject([{ role: "user", content: "who is the chairperson" }]));
      expect(Buffer.byteLength(pkt, "utf8")).toBeLessThanOrEqual(PACKET_BYTE_CAP);
      expect(pkt).not.toMatch(KIND_TAG);
    });
  });
});

describe("M34.3 packet budget", () => {
  const RESULTS = readFileSync(join(import.meta.dir, "../benchmarks/terminal-bench/RESULTS.md"), "utf8");

  test("default and environment-derived k stay in [6, 10]", async () => {
    expect(PACKET_CHAT_K_MIN).toBe(6);
    expect(PACKET_CHAT_K_MAX).toBe(10);
    expect(PACKET_CHAT_K_DEFAULT).toBe(6);
    expect(PACKET_CHAT_K_DEFAULT).toBeGreaterThanOrEqual(PACKET_CHAT_K_MIN);
    expect(PACKET_CHAT_K_DEFAULT).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
    const k = defaultNotesForK();
    expect(k).toBe(PACKET_CHAT_K_DEFAULT);
    expect(k).toBeGreaterThanOrEqual(6);
    expect(k).toBeLessThanOrEqual(10);
    expect(INDEX_SRC).toMatch(/relevant\(text: string, cap = memoryRetrieveCap\(\)/);
    await withEnv({ EDEN_MEMORY_CAP: "40" }, () => {
      expect(memoryRetrieveCap()).toBe(PACKET_CHAT_K_MAX);
      withMem((mem) => {
        mem.quiet(() => {
          for (let n = 1; n <= 40; n++) mem.remember(`Hard packet slot ${n} belongs to the omega catalog.`);
        });
        const notes = mem.notesFor("omega catalog");
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.length).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
      });
    });
  });

  test("huge [procedure] body is capped at PROCEDURE_CHAR_CAP and keeps verify:", () => {
    expect(PROCEDURE_TOKEN_CAP).toBe(300);
    expect(PROCEDURE_CHAR_CAP).toBe(PROCEDURE_TOKEN_CAP * 4);
    expect(PROCEDURE_CHAR_CAP).toBe(1200);
    expect(FACT_CHAR_CAP).toBe(PROCEDURE_CHAR_CAP);
    expect(FACT_CHAR_CAP).toBeLessThanOrEqual(1200);
    const verify = "verify: echo edenpacketbudgettoken";
    const huge = `${"step ".repeat(800)} · ${verify}`;
    expect(huge.length).toBeGreaterThan(PROCEDURE_CHAR_CAP);
    withMem((mem) => {
      mem.remember(huge, { kind: "procedure" });
      const hit = mem.notesFor("edenpacketbudgettoken").find((r) => /edenpacketbudgettoken/.test(r.text));
      expect(hit).toBeTruthy();
      expect(hit!.text).toMatch(kindPrefix("procedure"));
      const body = hit!.text.replace(/^\s*\[procedure(?:\s*·[^\]]*)?\]\s*/, "");
      expect(body.length).toBeLessThanOrEqual(PROCEDURE_CHAR_CAP);
      expect(body).toContain("verify:");
      expect(body).toContain("edenpacketbudgettoken");
      expect(body).not.toContain("step ".repeat(400));
      const pkt = packetOf(mem.inject([{ role: "user", content: "edenpacketbudgettoken" }]));
      const line = pkt.split("\n").find((l) => l.startsWith("- ") && /edenpacketbudgettoken/.test(l)) ?? "";
      expect(line).not.toMatch(KIND_TAG);
      expect(line).toContain("verify:");
      const lineBody = line.replace(/^- /, "").replace(/ \([^()]*just now\)$/, "");
      expect(lineBody).toBe(body);
      expect(lineBody.length).toBeLessThanOrEqual(PROCEDURE_CHAR_CAP);
    });
  });

  test("slice budget is 300 tokens and retrieve k max is ≤ 10, not 40", () => {
    expect(EXPERIENCE_SLICE_TOKEN_CAP).toBe(300);
    expect(EXPERIENCE_SLICE_CHAR_CAP).toBe(EXPERIENCE_SLICE_TOKEN_CAP * 4);
    expect(EXPERIENCE_RETRIEVE_K).toBe(3);
    expect(EXPERIENCE_RETRIEVE_K).toBeLessThanOrEqual(EXPERIENCE_RETRIEVE_K_MAX);
    expect(EXPERIENCE_RETRIEVE_K_MAX).toBeLessThanOrEqual(10);
    expect(EXPERIENCE_RETRIEVE_K_MAX).toBeLessThan(40);
    expect(EXPERIENCE_RETRIEVE_K_MAX).not.toBe(40);
  });

  test("packet bullets ≤ k", async () => {
    const k = defaultNotesForK();
    expect(k).toBeGreaterThanOrEqual(PACKET_CHAT_K_MIN);
    expect(k).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
    await withEnv({ EDEN_MEMORY_CAP: undefined }, () => {
      withMem((mem) => {
        mem.quiet(() => {
          for (let n = 1; n <= 20; n++) mem.remember(`Packet budget slot ${n} belongs to the alpha catalog.`);
        });
        const notes = mem.notesFor("alpha catalog");
        expect(notes.length).toBeLessThanOrEqual(k);
        expect(notes.length).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
        const bullets = packetOf(mem.inject([{ role: "user", content: "alpha catalog" }]))
          .split("\n")
          .filter((l) => l.startsWith("- "));
        expect(bullets.length).toBe(Math.min(notes.length, PACKET_SOFT_BULLETS));
      });
    });
  });

  test("Tokens with M32: Harbor prompt Δ +27759 and total +26941 are agent traces", () => {
    expect(INDEX_SRC).toMatch(/Tokens with M32/);
    expect(INDEX_SRC).toMatch(/150854 → 178613 \(\+27759\)/);
    expect(INDEX_SRC).toMatch(/total \+26941/);
    expect(INDEX_SRC).toMatch(/agent traces/);
    expect(INDEX_SRC).toMatch(/No 89-task claim/);
    expect(INDEX_SRC).toMatch(/No dual-API/);
    expect(RESULTS).toMatch(/tokens prompt/);
    expect(RESULTS).toMatch(/tokens total/);
    expect(RESULTS).toMatch(/Not the 89-task/);
    expect(RESULTS).toMatch(/No BrainMemory column/);
    const upper =
      PACKET_CHAT_K_MAX * PROCEDURE_TOKEN_CAP +
      EXPERIENCE_RETRIEVE_K_MAX * EXPERIENCE_SLICE_TOKEN_CAP +
      PROCEDURE_TOKEN_CAP;
    expect(upper).toBe(6300);
    expect(upper).toBeLessThan(27759);
  });
});

describe("M39 diverse packet", () => {
  const SQLITE_CUE = "what database do we use sqlite";
  const SQLITE_BASE = "Use sqlite as the primary database.";
  const MATH = "what's 2+2?";
  const MIX_CUE = "sqlite task files src/task schema migrate";

  function sqliteClones(): string[] {
    return Array.from({ length: 10 }, (_, i) => `${SQLITE_BASE} (copy ${i + 1})`);
  }

  function rememberClones(mem: AgentMemory, idPrefix: string): void {
    mem.quiet(() => {
      sqliteClones().forEach((text, i) => {
        mem.remember(text, { kind: "fact", id: `${idPrefix}-${i + 1}` });
      });
    });
  }

  function bulletsOf(pkt: string): string[] {
    return pkt.split("\n").filter((l) => l.startsWith("- "));
  }

  test("10 on-cue sqlite clones collapse to 1 slot", () => {
    withMem((mem) => {
      rememberClones(mem, "m39-clone");
      const stored = mem.memories().filter((r) => /sqlite/i.test(r.text));
      expect(stored.length).toBe(10);
      expect(new Set(stored.map((r) => r.id)).size).toBe(10);

      const notes = mem.notesFor(SQLITE_CUE);
      const sqliteNotes = notes.filter((r) => /sqlite/i.test(r.text));
      expect(sqliteNotes.length).toBe(1);
      expect(notes.length).toBeLessThanOrEqual(PACKET_CHAT_K_MAX);
      expect(notes.length).toBeLessThanOrEqual(10);

      const pkt = packetOf(mem.inject([{ role: "user", content: SQLITE_CUE }]));
      const sqliteLines = bulletsOf(pkt).filter((l) => /sqlite/i.test(l));
      expect(pkt).toContain(MEMORY_MARK);
      expect(sqliteLines.length).toBe(1);
      expect(sqliteLines[0]).not.toMatch(KIND_TAG);
      expect(bulletsOf(pkt).length).toBeLessThanOrEqual(PACKET_SOFT_BULLETS);
    });
  });

  test("mix budget keeps a fact and a procedure, not 10 copies", () => {
    const verify = "verify: bun test src/task/migrate.ts";
    const steps = "step ".repeat(800);
    const procedure = `${steps} Migrate sqlite task files → src/task/schema.ts src/task/migrate.ts · ${verify}`;
    expect(procedure.length).toBeGreaterThan(PROCEDURE_CHAR_CAP);
    const facts = [
      "sqlite task files keep the schema in src/task/schema.ts.",
      "seed loads demo rows for sqlite task files via src/task/seed.ts.",
      "backup copies sqlite task files nightly from src/task/backup.ts.",
      "indexes for sqlite task files are declared in src/task/indexes.ts.",
      "the pool that opens sqlite task files lives in src/task/pool.ts.",
      "wal mode for sqlite task files is set in src/task/wal.ts.",
      "foreign keys on sqlite task files turn on in src/task/fk.ts.",
      "pragma busy timeout for sqlite task files sits in src/task/pragma.ts.",
      "vacuum of sqlite task files runs from src/task/vacuum.ts.",
      "grants on sqlite task files are listed in src/task/grants.ts.",
    ];
    const episode = "2026-09-24 slice: edited src/task/schema.ts while sqlite task files were open.";
    withMem((mem) => {
      mem.quiet(() => {
        facts.forEach((text, i) => mem.remember(text, { kind: "fact", id: `m39-mix-fact-${i + 1}` }));
        mem.remember(procedure, { kind: "procedure", id: "m39-mix-proc" });
        mem.remember(episode, { kind: "episode", id: "m39-mix-slice" });
      });
      const notes = mem.notesFor(MIX_CUE);
      expect(notes.length).toBeLessThanOrEqual(10);
      expect(notes.some((r) => r.kind === "fact" || new RegExp(kindLabel("fact")).test(r.text))).toBe(true);
      expect(notes.some((r) => r.kind === "procedure" || new RegExp(kindLabel("procedure")).test(r.text))).toBe(true);
      const noteProc = notes.find((r) => r.kind === "procedure" || new RegExp(kindLabel("procedure")).test(r.text));
      expect(noteProc).toBeTruthy();
      const noteBody = String(noteProc!.text).replace(/^\s*\[procedure(?:\s*·[^\]]*)?\]\s*/, "");
      expect(noteBody.length).toBeLessThanOrEqual(PROCEDURE_CHAR_CAP);
      expect(noteBody).toContain("verify:");

      const pkt = packetOf(mem.inject([{ role: "user", content: MIX_CUE }]));
      const bullets = bulletsOf(pkt);
      // D14 words bullets without kind tags: the procedure is the one with its verify step.
      const procLines = bullets.filter((l) => l.includes(verify));
      const factLines = bullets.filter((l) => facts.some((fact) => l.startsWith(`- ${fact}`)));
      expect(pkt).toContain(MEMORY_MARK);
      expect(pkt).not.toMatch(KIND_TAG);
      expect(factLines.length).toBeGreaterThanOrEqual(1);
      expect(procLines).toHaveLength(1);
      expect(new Set(factLines).size).toBe(factLines.length);
      expect(bullets.length).toBeLessThanOrEqual(PACKET_SOFT_BULLETS);
      const procBody = procLines[0]!.replace(/^- /, "").replace(/ \([^()]*just now\)$/, "");
      expect(procBody.length).toBeLessThanOrEqual(PROCEDURE_CHAR_CAP);
      expect(procBody.length).toBeLessThanOrEqual(PROCEDURE_TOKEN_CAP * 4);
      expect(procBody).toContain("verify:");
      expect(procBody).not.toContain("step ".repeat(400));
    });
  });

  test("silent still wins when every sqlite clone is off-cue", async () => {
    await withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_MIN: undefined, EDEN_KNOW: "0" }, () => {
      withMem((mem) => {
        rememberClones(mem, "m39-silent");
        expect(mem.memories().filter((r) => /sqlite/i.test(r.text)).length).toBe(10);
        const list = [{ role: "user", content: MATH }];
        const out = mem.inject(list);
        expect(out).toBe(list);
        expect(packetOf(out as unknown[])).not.toContain(MEMORY_MARK);
        expect(JSON.stringify(out)).not.toContain("Eden Memory:");
        expect(JSON.stringify(out)).not.toMatch(/sqlite/i);
      });
    });
    const offDir = tmpDir("eden-m39-off-");
    try {
      await withEnv({ EDEN_MEMORY: "on", EDEN_MEMORY_MIN: undefined, EDEN_KNOW: "0" }, async () => {
        const mem = openMemory({ dir: offDir });
        rememberClones(mem, "m39-off");
        const list = [{ role: "user", content: SQLITE_CUE }];
        await withEnv({ EDEN_MEMORY: "0", EDEN_KNOW: "0" }, () => {
          const out = mem.inject(list);
          expect(out).toBe(list);
          expect(packetOf(out as unknown[])).not.toContain(MEMORY_MARK);
          expect(JSON.stringify(out)).not.toContain("Eden Memory:");
        });
      });
    } finally {
      rmSync(offDir, { recursive: true, force: true });
    }
  });
});

describe("M40 provenance", () => {
  const PG = "The database is postgres.";
  const SQLITE = "The database is sqlite.";
  const CUE = "what database do we use";
  const EMAIL = "kai-m40@example.com";
  const CWD = "/tmp/eden-m40-cwd";
  const SESSION = "sess-m40-unique";
  const LOG_ID = "m40-log-note-id";

  function bracketsOf(text: string): string[] {
    return text.match(/\[[^\]]+\]/g) ?? [];
  }

  /** The closing parenthetical of each bullet: D14's source and age. */
  function provenanceOf(packet: string): string[] {
    return packet
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .flatMap((line) => line.match(/\(([^()]*)\)$/)?.slice(1) ?? []);
  }

  function captureStderr(fn: () => void): string {
    const chunks: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    const writeSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      errSpy.mockRestore();
      writeSpy.mockRestore();
    }
    return chunks.join("\n");
  }

  async function withProcessMem<T>(mem: AgentMemory, fn: () => T | Promise<T>): Promise<T> {
    const procSpy = spyOn(edenMem, "processMemory").mockImplementation(() => mem);
    const openSpy = spyOn(edenMem, "openMemory").mockImplementation(() => mem);
    try {
      return await fn();
    } finally {
      procSpy.mockRestore();
      openSpy.mockRestore();
    }
  }

  test("dated sqlite fact stays; postgres loser stays absent", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: SQLITE }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).toMatch(/sqlite/i);
      expect(pkt).not.toMatch(/postgres/i);
      // D14 (the wrap's wording since P0.7): the provenance is the bullet's closing words, its age.
      const provenance = provenanceOf(pkt);
      expect(provenance.length).toBeGreaterThan(0);
      for (const words of provenance) {
        expect(words).toMatch(/just now|ago$/);
        for (const id of [EMAIL, CWD, SESSION]) expect(words).not.toContain(id);
      }
    });
  });

  test("a legacy serial time claims no age (A1 D6); wall-clock 3h is 3h; identifiers never in the age token", () => {
    expect(relativeMemoryAge(8)).toBeUndefined();
    expect(relativeMemoryAge(Date.now() - 3 * 3600_000)).toBe("3h");
    expect(relativeMemoryAge(Date.now())).toBe("0m");
    expect(relativeMemoryAge(Date.now() - 3 * 3600_000)).not.toMatch(/@|\//);
  });

  test("procedure with verify: bun test is labeled verified and the label has no cwd", () => {
    withMem((mem) => {
      mem.remember("Migrate the schema → src/task/migrate.ts · verify: bun test", { kind: "procedure" });
      const cue = "migrate schema bun test";
      const notes = mem.notesFor(cue);
      const pkt = packetOf(mem.inject([{ role: "user", content: cue }]));
      const hay = `${notes.map((r) => r.text).join("\n")}\n${pkt}`;
      expect(hay).toMatch(/\[procedure\s*·[^\]]*verified[^\]]*\]/i);
      for (const b of bracketsOf(hay).filter((x) => /^\[procedure\b/i.test(x))) {
        expect(b).not.toContain(CWD);
        expect(b).not.toMatch(/cwd/i);
      }
    });
  });

  test("labels omit session, email, and cwd", () => {
    const dir = tmpDir("eden-m40-ids-");
    try {
      const mem = openMemory({ dir, session: SESSION, cwd: CWD });
      mem.observe([
        {
          role: "user",
          content: `The database is sqlite. Contact ${EMAIL}. cwd ${CWD}. session ${SESSION}.`,
        },
      ]);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      expect(pkt).not.toMatch(KIND_TAG);
      expect(pkt).toMatch(/sqlite/i);
      const labels = [...bracketsOf(pkt), ...provenanceOf(pkt)];
      for (const id of [EMAIL, CWD, SESSION]) {
        for (const b of labels) expect(b).not.toContain(id);
      }
      const outside = pkt.replace(/\[[^\]]+\]/g, "");
      for (const id of [EMAIL, CWD, SESSION]) {
        if (!outside.includes(id)) expect(pkt).not.toContain(id);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("log is off by default and EDEN_MEMORY=0 stays identity", async () => {
    await withEnv({ EDEN_MEMORY_LOG: undefined }, () => {
      withMem((mem) => {
        mem.remember(SQLITE, { kind: "fact", id: LOG_ID });
        const list = [{ role: "user", content: CUE }];
        let pkt = "";
        const stderr = captureStderr(() => {
          pkt = packetOf(mem.inject(list));
        });
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toMatch(/sqlite/i);
        expect(pkt).not.toContain(LOG_ID);
        expect(stderr).not.toContain(LOG_ID);
        expect(stderr).not.toContain("EDEN_MEMORY_LOG");
        const off = [{ role: "user", content: CUE }];
        const identity = (() => {
          const prev = process.env.EDEN_MEMORY;
          process.env.EDEN_MEMORY = "0";
          try {
            return mem.inject(off);
          } finally {
            if (prev === undefined) delete process.env.EDEN_MEMORY;
            else process.env.EDEN_MEMORY = prev;
          }
        })();
        expect(identity).toBe(off);
        expect(packetOf(identity as unknown[])).not.toContain(MEMORY_MARK);
      });
    });
  });

  test("EDEN_MEMORY_LOG=1 prints ids and ages on stderr only", async () => {
    await withEnv({ EDEN_MEMORY_LOG: "1" }, () => {
      withMem((mem) => {
        mem.remember(SQLITE, { kind: "fact", id: LOG_ID });
        let pkt = "";
        const stderr = captureStderr(() => {
          pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
        });
        expect(pkt).toContain(MEMORY_MARK);
        expect(pkt).toMatch(/sqlite/);
        expect(pkt).not.toContain(LOG_ID);
        expect(stderr).toContain(LOG_ID);
        expect(stderr).toMatch(REL_AGE);
      });
    });
  });

  test("the wrap and the hook both word their notes (D14), without log chrome", async () => {
    const dir = tmpDir("eden-m40-host-");
    await withEnv(
      { EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_LOG: undefined },
      async () => {
        const mem = openMemory({ dir, session: "s-m40-host" });
        try {
          mem.remember(SQLITE, { kind: "fact", id: LOG_ID });
          const messages = [{ role: "user", content: CUE }];
          const body = mem.injectBody({ model: "gpt-4o", messages });
          const openai = packetOf((body.messages ?? []) as unknown[]);
          expect(openai).toContain(MEMORY_MARK);
          expect(openai).toMatch(/^- (?!Rule ).*sqlite/im);
          expect(openai).not.toMatch(KIND_TAG);
          expect(openai).not.toContain(LOG_ID);
          await withProcessMem(mem, () => {
            const anth = withKnowFactsAnthropic({ system: "You are a coding agent.", messages });
            const anthHay = JSON.stringify(anth);
            expect(anthHay).toContain(MEMORY_MARK);
            expect(anthHay).toMatch(/sqlite/i);
            expect(anthHay).not.toMatch(KIND_TAG);
            expect(anthHay).not.toContain(LOG_ID);
            const hook = memoryHookResponse({
              hook_event_name: "UserPromptSubmit",
              session_id: "s-m40-host",
              prompt: CUE,
            });
            const ctx = hookContext(hook);
            expect(ctx).toContain(MEMORY_MARK);
            expect(ctx).toMatch(/^- (?!Rule ).*sqlite/im);
            expect(ctx).not.toContain(LOG_ID);
            expect(String(hook?.additional_context ?? "")).not.toContain(LOG_ID);
          });
        } finally {
          try {
            mem.close();
          } catch {}
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  test("EDEN_MEMORY_LOG=1 does not leak note ids into additional_context", async () => {
    const dir = tmpDir("eden-m40-host-log-");
    await withEnv(
      { EDEN_MEMORY: "on", EDEN_MEMORY_DIR: dir, EDEN_HOME: undefined, EDEN_KNOW: "0", EDEN_MEMORY_LOG: "1" },
      async () => {
        const mem = openMemory({ dir, session: "s-m40-host-log" });
        try {
          mem.remember(SQLITE, { kind: "fact", id: LOG_ID });
          await withProcessMem(mem, () => {
            let ctx = "";
            const stderr = captureStderr(() => {
              const hook = memoryHookResponse({
                hook_event_name: "UserPromptSubmit",
                session_id: "s-m40-host-log",
                prompt: CUE,
              });
              ctx = hookContext(hook);
            });
            expect(ctx).toContain(MEMORY_MARK);
            expect(ctx).toMatch(/sqlite/i);
            expect(ctx).not.toContain(LOG_ID);
            expect(stderr).toContain(LOG_ID);
          });
        } finally {
          try {
            mem.close();
          } catch {}
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  test("M40 pin: content words stay user, one label, a legacy serial time claims no age, gap is not verified", () => {
    withMem((mem) => {
      mem.observe([{ role: "user", content: PG }]);
      mem.observe([{ role: "user", content: "The sleep interval is thirty." }]);
      mem.observe([{ role: "user", content: "The deploy tool is kubectl." }]);
      mem.observe([{ role: "user", content: SQLITE }]);
      const pkt = packetOf(mem.inject([{ role: "user", content: CUE }]));
      // A row `observe` took with no source claims none in the packet (D14, A6 §2.1); notesFor still labels it.
      expect(pkt).toMatch(/^- The database is sqlite\.? \(just now\)$/m);
      expect(pkt).not.toMatch(/postgres/i);
      expect(pkt).not.toMatch(KIND_TAG);
      const sleep = mem.notesFor("sleep interval thirty").find((r) => /sleep interval/i.test(r.text));
      const tool = mem.notesFor("deploy tool kubectl").find((r) => /kubectl/i.test(r.text));
      expect(sleep?.text).toMatch(/^\[fact · \d+[mhdw] · user\]/);
      expect(sleep?.text).not.toMatch(/\[fact[^\]]*·\s*sleep\]/);
      expect(tool?.text).toMatch(/^\[fact · \d+[mhdw] · user\]/);
      expect(tool?.text).not.toMatch(/\[fact[^\]]*·\s*tool\]/);
      mem.remember("[fact | 3h | user] [fact] The cache is redis.", { kind: "fact" });
      const piped = mem.notesFor("cache redis").find((r) => /redis/i.test(r.text));
      expect(piped?.text).toMatch(/^\[fact · \d+[mhdw] · user\] The cache is redis/);
      expect(piped?.text).not.toMatch(/\[fact[^\]]*\]\s+\[fact\b/i);
      expect(piped?.text).not.toMatch(/\|/);
      mem.remember("auth pytest · unknown: missing step", { kind: "procedure", tags: ["howto", "procedure"] });
      const gap = mem.notesFor("auth pytest missing step").find((r) => /unknown:/i.test(r.text));
      expect(gap?.text).toMatch(/^\[procedure · \d+[mhdw] · tool\]/);
      expect(gap?.text).not.toMatch(/verified/);
      mem.remember("auth pytest · verify: bun test", { kind: "procedure", tags: ["howto", "procedure"] });
      const ok = mem.notesFor("auth pytest bun test").find((r) => /verify:/i.test(r.text) && !/unknown:/i.test(r.text));
      expect(ok?.text).toMatch(/^\[procedure · verified\]/);
      mem.remember("auth pytest · verify: bun test · unknown: missing step", {
        kind: "procedure",
        tags: ["howto", "procedure"],
      });
      const both = mem
        .notesFor("auth pytest bun test missing step")
        .find((r) => /verify:/i.test(r.text) && /unknown:/i.test(r.text));
      expect(both?.text).toMatch(/unknown:/);
      expect(both?.text).not.toMatch(/^\[procedure · verified\]/);
      expect(
        applyProvenanceLabel(
          { kind: "procedure", tags: ["howto", "verified"] },
          "auth pytest · verify: bun test · unknown: missing step",
        ),
      ).not.toMatch(/^\[procedure · verified\]/);
    });
    withMem((mem, dir) => {
      new HowToStore(dir).put({
        cue: "fix auth pytest flake",
        steps: [{ name: "Bash", args: { cmd: "pytest tests/auth/session.test.ts -q" } }],
        files: ["auth.ts"],
        exit: 0,
        t: Date.now(),
      });
      const pkt = packetOf(mem.inject([{ role: "user", content: "the flake is in auth.ts" }]));
      expect(pkt).toMatch(/unknown:/);
      expect(pkt).not.toMatch(/verified/);
    });
    const dir = tmpDir("eden-m40-serial-");
    try {
      writeFileSync(
        join(dir, "memories.jsonl"),
        `${JSON.stringify({
          id: "serial8",
          text: SQLITE,
          kind: "fact",
          tags: ["sleep", "tool", "gist"],
          at: 8,
          lane: "chat",
        })}\n`,
      );
      const mem = openMemory({ dir });
      const text = mem
        .notesFor(CUE)
        .map((r) => r.text)
        .join("\n");
      expect(text).toMatch(/^\[fact · user\]/m);
      expect(text).not.toMatch(/\d{3,}w/);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(CWD);
      expect(text).not.toContain(SESSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(memoryLogEnabled(undefined)).toBe(false);
    const stderr = captureStderr(() => {
      process.env.EDEN_MEMORY_LOG = "1";
      try {
        logMemoryNotes([
          { id: EMAIL, at: 8 },
          { id: CWD, at: 8 },
          { id: SESSION, at: Date.now() - 3 * 3600_000 },
          { id: LOG_ID, at: 8, text: `${EMAIL} ${CWD} ${SESSION}` },
        ]);
      } finally {
        delete process.env.EDEN_MEMORY_LOG;
      }
    });
    expect(stderr).toMatch(new RegExp(`${LOG_ID}(?!:)`));
    expect(stderr).toContain(`${SESSION}:3h`);
    expect(stderr).not.toContain(EMAIL);
    expect(stderr).not.toContain(CWD);
    expect(stderr).not.toContain("secret");
  });
});
