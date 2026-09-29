/**
 * M48.2 multi-session proof. Not a Gate 1 re-run.
 *
 *   bun benchmarks/memory-holdout/run-multisession.ts
 *
 * Session A observes the Clerk ADR via UserPromptSubmit. Session B cues
 * "what auth provider?" on the same EDEN_MEMORY_DIR. Score additionalContext
 * only. Stop consolidates root semantic/gist only when that file still lacks
 * Clerk (otherwise session B cannot see A's episode JSONL). Ranker not retuned.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHook } from "../../packages/cli/src/hook.ts";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook.ts";
import { MEMORY_MARK, openMemory } from "../../src/index.ts";
import { additionalContextOf, hitsIn, withEnv } from "./run-tools.ts";

export const HOLD_DIR = import.meta.dir;
export const RESULTS_PATH = join(HOLD_DIR, "RESULTS.md");
export const MULTI_PATH = join(HOLD_DIR, "RESULTS-MULTI.md");

export const PRODUCT_APIS = { respondToHook, memoryHookResponse, openMemory } as const;

const ADR = "We decided to use Clerk for auth because SSO.";
const CUE = "what auth provider?";
const MATH = "what's 2+2?";
const SESSION_A = "holdout-adr-a";
const SESSION_B = "holdout-adr-b";
const CWD = "/tmp/eden-holdout-adr";
const NEEDLE = "Clerk";
const SECTION_HEAD = "## Multi-session";

type Rec = Record<string, unknown>;

export type MultiSessionRun = {
  date: string;
  clerk: boolean;
  inject_hits: string[];
  inject_text: string;
  math_omitted: boolean;
  math_has_clerk: boolean;
  math_text: string;
  stop_flushed: boolean;
  session_a_jsonl: boolean;
  root_semantic: boolean;
  root_gist: boolean;
  same_session_clerk: boolean;
};

function readIf(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function rootHasClerk(memDir: string): { semantic: boolean; gist: boolean } {
  const semantic = /clerk/i.test(readIf(join(memDir, "semantic.jsonl")));
  const gist = /clerk/i.test(readIf(join(memDir, "gists.jsonl")));
  return { semantic, gist };
}

export function formatMultiSession(run: MultiSessionRun): string {
  const hits = run.inject_hits.length ? run.inject_hits.join("; ") : "—";
  const verdict = run.clerk ? "PASS" : "LOSS";
  const close = run.clerk ? "Pass." : "LOSS. Clerk absent from session B inject.";
  const flush = run.stop_flushed
    ? "Stop on session A ran after UserPromptSubmit because root semantic and gist still lacked Clerk."
    : "Stop not required: root semantic or gist already held Clerk after session A UserPromptSubmit.";
  const stored = run.session_a_jsonl
    ? "Session A JSONL contained Clerk after UserPromptSubmit."
    : "Session A JSONL did not contain Clerk after UserPromptSubmit.";
  const root = `After that flush check, root semantic ${run.root_semantic ? "contained" : "lacked"} Clerk and root gist ${run.root_gist ? "contained" : "lacked"} Clerk.`;
  const same = run.same_session_clerk
    ? "Same cue on session A injected Clerk (store live; not a scored cell)."
    : "Same cue on session A also missed Clerk (not a scored cell).";
  const math = run.math_omitted
    ? `Math cue on B (\`${MATH}\`) omitted the packet (M38). Not a scored cell.`
    : `Math cue on B (\`${MATH}\`) still injected${run.math_has_clerk ? " (Clerk present)" : ""}. Not a scored cell.`;
  return [
    SECTION_HEAD,
    "",
    `**Date:** ${run.date}`,
    "**API:** hook-inject (`respondToHook` / `memoryHookResponse` + `openMemory`)",
    "**Proof:** session A encode ADR → session B inject (M44). Not a second full Gate 1 re-run.",
    "",
    "| case | session A | session B cue | inject hits | verdict |",
    "|---|---|---|---|---|",
    `| adr-across-sessions | Clerk ADR observed | ${CUE} | ${hits} | ${verdict} |`,
    "",
    `${close} Ranker not retuned. Dual-API forbidden. No BrainMemory column.`,
    "",
    `${stored} ${flush} ${root} ${same}`,
    math,
    "",
  ].join("\n");
}

/** Replace an existing Multi-session section. Leave Gate 1 and Silence alone. */
export function upsertMultiSession(existing: string, section: string): string {
  const block = section.replace(/\s+$/, "");
  const text = existing.replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === SECTION_HEAD);
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        end = i;
        break;
      }
    }
    const next = [...lines.slice(0, start), ...block.split("\n"), "", ...lines.slice(end)];
    return next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }
  const base = text.replace(/\s+$/, "");
  return (base ? `${base}\n\n` : "") + block + "\n";
}

export function writeMultiSession(section: string, resultsPath = RESULTS_PATH, multiPath = MULTI_PATH): void {
  writeFileSync(multiPath, section.endsWith("\n") ? section : `${section}\n`);
  let existing = "";
  try {
    existing = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8") : "";
  } catch {
    existing = "";
  }
  writeFileSync(resultsPath, upsertMultiSession(existing, section));
}

export async function runMultiSession(): Promise<MultiSessionRun> {
  const home = join(tmpdir(), `eden-m482-multi-${Math.random().toString(36).slice(2)}`);
  const memDir = join(home, "memory");
  mkdirSync(memDir, { recursive: true });
  const submit = (session: string, prompt: string): Rec => ({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    cwd: CWD,
    prompt,
  });
  try {
    return await withEnv(
      {
        EDEN_HOME: home,
        EDEN_MEMORY_DIR: memDir,
        EDEN_MEMORY: "on",
        EDEN_KNOW: "0",
        EDEN_SLEEP_EVERY: "0",
        EDEN_SLEEP_IDLE: "0",
        EDEN_MEMORY_MIN: undefined,
      },
      async () => {
        await respondToHook(submit(SESSION_A, ADR));
        const sessionJsonl = readIf(join(memDir, SESSION_A, "memories.jsonl"));
        let root = rootHasClerk(memDir);
        let stopFlushed = false;
        if (!root.semantic && !root.gist) {
          stopFlushed = true;
          memoryHookResponse({ hook_event_name: "Stop", session_id: SESSION_A, cwd: CWD });
          root = rootHasClerk(memDir);
        }
        const cueOut = await respondToHook(submit(SESSION_B, CUE));
        const inject = additionalContextOf(cueOut as Rec);
        const injected = hitsIn(inject, [NEEDLE]);
        const mathOut = await respondToHook(submit(SESSION_B, MATH));
        const mathText = additionalContextOf(mathOut as Rec);
        const mathHasClerk = /clerk/i.test(mathText);
        const mathOmitted = !mathText.includes(MEMORY_MARK) && !mathHasClerk;
        const sameOut = await respondToHook(submit(SESSION_A, CUE));
        const sameClerk = hitsIn(additionalContextOf(sameOut as Rec), [NEEDLE]).hit.length > 0;
        if (!PRODUCT_APIS.respondToHook || !PRODUCT_APIS.memoryHookResponse || !PRODUCT_APIS.openMemory) {
          throw new Error("hook-inject API missing");
        }
        return {
          date: new Date().toISOString().slice(0, 10),
          clerk: injected.hit.length > 0,
          inject_hits: injected.hit,
          inject_text: inject,
          math_omitted: mathOmitted,
          math_has_clerk: mathHasClerk,
          math_text: mathText,
          stop_flushed: stopFlushed,
          session_a_jsonl: /clerk/i.test(sessionJsonl),
          root_semantic: root.semantic,
          root_gist: root.gist,
          same_session_clerk: sameClerk,
        };
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const direct = import.meta.path === Bun.main;
if (direct) {
  const run = await runMultiSession();
  const section = formatMultiSession(run);
  writeMultiSession(section);
  process.stdout.write(
    `${JSON.stringify(
      {
        clerk: run.clerk,
        inject_hits: run.inject_hits,
        stop_flushed: run.stop_flushed,
        session_a_jsonl: run.session_a_jsonl,
        root_semantic: run.root_semantic,
        root_gist: run.root_gist,
        math_omitted: run.math_omitted,
        same_session_clerk: run.same_session_clerk,
        math_has_clerk: run.math_has_clerk,
        inject_preview: run.inject_text.replace(/\s+/g, " ").slice(0, 400),
        math_preview: run.math_text.replace(/\s+/g, " ").slice(0, 200),
      },
      null,
      2,
    )}\n`,
  );
}
