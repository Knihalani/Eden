/**
 * M32.3 remain-silent measure: empty vs junk vs on-cue.
 * Does not launch Harbor. Core omit gate lives in src/index.ts (M38).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MEMORY_MARK, openMemory } from "../../src/index.ts";
import { injectBodyThenObserveTools } from "../../packages/wrap/src/tool-observe.ts";
import { injectLogPath, pendingResultsReport, renderResults } from "./run.ts";
import {
  classifyInject,
  classifyTrial,
  countNotes,
  countSilence,
  defaultInjectLogPath,
  packetIsJunk,
  silenceNotes,
  type InjectLogLine,
} from "./silence.ts";

const ROOT = join(import.meta.dir, "../..");
const ON_JOB = join(import.meta.dir, "jobs/eden-m153-on-google-gemma-4-31b-it");
const OPENSSL_CUE =
  "Create a self-signed TLS certificate using OpenSSL. Save the SHA-256 fingerprint.";
const SQLITE_PACKET = `${MEMORY_MARK}\n- sqlite is the database.\n- Auth is Clerk.\n- CI is CircleCI.\n- postgres is the session store.\n- Kai is on a peanut diet.`;
const OPENSSL_PACKET = `${MEMORY_MARK}\n- Use openssl req to mint a TLS cert.\n- Record the SHA-256 fingerprint.`;
const REGEX_PACKET = `${MEMORY_MARK}\n- Parse the log with a regex capture.`;

function tmp(prefix = "eden-m323-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function writeTrial(
  job: string,
  trial: string,
  task: string,
  t0: string,
  t1: string,
): void {
  const dir = join(job, trial);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({
      task_name: task,
      trial_name: trial,
      started_at: t0,
      finished_at: t1,
      agent_execution: { started_at: t0, finished_at: t1 },
    }) + "\n",
  );
}

function logLine(partial: Partial<InjectLogLine> & { t: number }): string {
  return JSON.stringify({
    empty: false,
    n_notes: 0,
    junk: false,
    cue: "",
    packet: "",
    ...partial,
  });
}

describe("classify empty vs junk vs on-cue", () => {
  test("empty = injected body has no MEMORY_MARK (packet omitted)", () => {
    const c = classifyInject({
      original: { messages: [{ role: "user", content: OPENSSL_CUE }] },
      injected: { messages: [{ role: "user", content: OPENSSL_CUE }] },
    });
    expect(c.empty).toBe(true);
    expect(c.junk).toBe(false);
    expect(c.n_notes).toBe(0);
    expect(c.packet).not.toContain(MEMORY_MARK);
  });

  test("leftover sqlite/Clerk/postgres/CircleCI/diet on openssl cue is junk", () => {
    expect(packetIsJunk(SQLITE_PACKET, OPENSSL_CUE)).toBe(true);
    const c = classifyInject({
      cue: OPENSSL_CUE,
      packet: SQLITE_PACKET,
    });
    expect(c.empty).toBe(false);
    expect(c.junk).toBe(true);
    expect(c.n_notes).toBe(5);
  });

  test("openssl notes sharing cert/tls/fingerprint with the cue are on-cue, not junk", () => {
    expect(packetIsJunk(OPENSSL_PACKET, OPENSSL_CUE)).toBe(false);
    const c = classifyInject({ cue: OPENSSL_CUE, packet: OPENSSL_PACKET });
    expect(c.empty).toBe(false);
    expect(c.junk).toBe(false);
    expect(countNotes(OPENSSL_PACKET)).toBe(2);
  });

  test("regex/log packet is on-cue for a regex-log cue", () => {
    const cue = "Write a regex to parse the nginx access log.";
    expect(packetIsJunk(REGEX_PACKET, cue)).toBe(false);
  });
});

describe("countSilence trial mapping", () => {
  test("maps inject JSONL onto trials by result.json timestamp windows; no wrap chat is no_inject", () => {
    const job = tmp("eden-m323-job-");
    const log = join(job, "inject.jsonl");
    try {
      const tA0 = "2026-09-21T10:00:00.000Z";
      const tA1 = "2026-09-21T10:05:00.000Z";
      const tB0 = "2026-09-21T10:10:00.000Z";
      const tB1 = "2026-09-21T10:15:00.000Z";
      const tC0 = "2026-09-21T10:20:00.000Z";
      const tC1 = "2026-09-21T10:25:00.000Z";
      writeTrial(job, "openssl-selfsigned-cert__empty", "terminal-bench/openssl-selfsigned-cert", tA0, tA1);
      writeTrial(job, "openssl-selfsigned-cert__junk", "terminal-bench/openssl-selfsigned-cert", tB0, tB1);
      writeTrial(job, "regex-log__dead", "terminal-bench/regex-log", tC0, tC1);

      const tEmpty = Date.parse(tA0) + 30_000;
      const tJunk = Date.parse(tB0) + 30_000;
      writeFileSync(
        log,
        [
          logLine({ t: tEmpty, arm: "on", empty: true, n_notes: 0, junk: false, cue: OPENSSL_CUE, packet: "" }),
          logLine({
            t: tJunk,
            arm: "on",
            empty: false,
            n_notes: 5,
            junk: true,
            cue: OPENSSL_CUE,
            packet: SQLITE_PACKET,
          }),
          logLine({ t: Date.parse(tC1) + 60_000, arm: "on", empty: true, cue: "unmapped", packet: "" }),
          "{not json",
        ].join("\n") + "\n",
      );

      const c = countSilence({ logPath: log, jobDir: job });
      expect(c.n_trials).toBe(3);
      expect(c.empty).toBe(1);
      expect(c.junk).toBe(1);
      expect(c.on_cue).toBe(0);
      expect(c.no_inject).toBe(1);
      expect(c.n_injects).toBe(3);

      const opensslOnly = countSilence({
        logPath: log,
        jobDir: job,
        tasks: ["terminal-bench/openssl-selfsigned-cert"],
      });
      expect(opensslOnly.n_trials).toBe(2);
      expect(opensslOnly.no_inject).toBe(0);
    } finally {
      rmSync(job, { recursive: true, force: true });
    }
  });

  test("missing log + Harbor job dirs: every trial is no_inject, not empty-packet", () => {
    const c = countSilence({
      logPath: join(ON_JOB, "no-such-inject.jsonl"),
      jobDir: ON_JOB,
    });
    expect(c.n_trials).toBe(10);
    expect(c.n_injects).toBe(0);
    expect(c.no_inject).toBe(10);
    expect(c.empty).toBe(0);
    expect(c.junk).toBe(0);
  });

  test("jobDir null still counts inject lines", () => {
    const dir = tmp("eden-m323-nolog-");
    const log = join(dir, "inject.jsonl");
    try {
      writeFileSync(log, logLine({ t: Date.now(), empty: true, cue: "x", packet: "" }) + "\n");
      const c = countSilence({ logPath: log, jobDir: null });
      expect(c.n_trials).toBe(0);
      expect(c.n_injects).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifyTrial: no mapped lines is no_inject, not empty", () => {
    expect(classifyTrial([])).toBe("no_inject");
  });
});

describe("wrap inject log (measure only)", () => {
  test("default off: zero behavior change — no JSONL written", () => {
    const dir = tmp("eden-m323-nologwrap-");
    const log = join(dir, "inject.jsonl");
    try {
      withEnv({ EDEN_MEMORY_INJECT_LOG: undefined, EDEN_MEMORY: "on" }, () => {
        const body = { messages: [{ role: "user", content: OPENSSL_CUE }] };
        const injected = {
          messages: [{ role: "system", content: OPENSSL_PACKET }, { role: "user", content: OPENSSL_CUE }],
        };
        const out = injectBodyThenObserveTools({ injectBody: () => injected, observe() {} }, body);
        expect(out).toBe(injected);
        expect(() => readFileSync(log, "utf8")).toThrow();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("EDEN_MEMORY=0 logs empty=true; on-arm leftover packet logs junk and is still injected", () => {
    const dir = tmp("eden-m323-wraplog-");
    const offLog = join(dir, "off.jsonl");
    const onLog = join(dir, "on.jsonl");
    try {
      withEnv({ EDEN_MEMORY_INJECT_LOG: offLog, EDEN_MEMORY: "0" }, () => {
        const mem = openMemory({ dir: join(dir, "off") });
        mem.observe([{ role: "user", content: "sqlite is the database." }]);
        const out = injectBodyThenObserveTools(mem, {
          messages: [{ role: "user", content: OPENSSL_CUE }],
        });
        expect(JSON.stringify(out)).not.toContain(MEMORY_MARK);
        const row = JSON.parse(readFileSync(offLog, "utf8").trim()) as InjectLogLine;
        expect(row.empty).toBe(true);
        expect(row.junk).toBe(false);
        expect(row.arm).toBe("off");
        expect(row.cue).toMatch(/openssl/i);
      });
      withEnv({ EDEN_MEMORY_INJECT_LOG: onLog, EDEN_MEMORY: "on" }, () => {
        const body = { messages: [{ role: "user", content: OPENSSL_CUE }] };
        const injected = {
          messages: [{ role: "system", content: SQLITE_PACKET }, { role: "user", content: OPENSSL_CUE }],
        };
        const out = injectBodyThenObserveTools(
          {
            injectBody: () => injected,
            observe() {},
          },
          body,
        );
        expect(out).toBe(injected);
        expect(JSON.stringify(out)).toContain(MEMORY_MARK);
        expect(JSON.stringify(out)).toMatch(/sqlite|Clerk/i);
        const row = JSON.parse(readFileSync(onLog, "utf8").trim()) as InjectLogLine;
        expect(row.empty).toBe(false);
        expect(row.junk).toBe(true);
        expect(row.n_notes).toBe(5);
        expect(row.packet).toContain(MEMORY_MARK);
        expect(row.arm).toBe("on");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fail-open: log path is a directory — inject still returns the packet", () => {
    const dir = tmp("eden-m323-failopen-");
    mkdirSync(join(dir, "not-a-file"));
    try {
      withEnv({ EDEN_MEMORY_INJECT_LOG: join(dir, "not-a-file"), EDEN_MEMORY: "on" }, () => {
        const body = { messages: [{ role: "user", content: OPENSSL_CUE }] };
        const injected = {
          messages: [{ role: "system", content: SQLITE_PACKET }, { role: "user", content: OPENSSL_CUE }],
        };
        expect(() =>
          injectBodyThenObserveTools({ injectBody: () => injected, observe() {} }, body),
        ).not.toThrow();
        const out = injectBodyThenObserveTools({ injectBody: () => injected, observe() {} }, body);
        expect(out).toBe(injected);
        expect(JSON.stringify(out)).toContain(MEMORY_MARK);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sqlite leftover on openssl or math is identity; on-cue openssl and sqlite still inject", () => {
    const dir = tmp("eden-m323-omit-");
    const math = "what's 2+2?";
    try {
      withEnv({ EDEN_MEMORY_INJECT_LOG: undefined, EDEN_MEMORY: "on", EDEN_KNOW: "0", EDEN_HOME: undefined, EDEN_MEMORY_MIN: undefined }, () => {
        const leftover = openMemory({ dir });
        leftover.observe([{ role: "user", content: "Use sqlite." }]);
        leftover.observe([{ role: "user", content: "Auth is Clerk" }]);
        for (const cue of [OPENSSL_CUE, math]) {
          const out = injectBodyThenObserveTools(leftover, { messages: [{ role: "user", content: cue }] });
          const blob = JSON.stringify(out);
          expect(blob).not.toContain(MEMORY_MARK);
          expect(Array.isArray((out as { messages?: unknown[] }).messages)).toBe(true);
          expect((out as { messages: unknown[] }).messages).toEqual([{ role: "user", content: cue }]);
        }
        leftover.close();
        const onOpenssl = openMemory({ dir: join(dir, "openssl") });
        onOpenssl.remember("Use openssl req -x509 to mint a TLS cert and record the fingerprint.");
        const opensslOut = injectBodyThenObserveTools(onOpenssl, {
          messages: [{ role: "user", content: OPENSSL_CUE }],
        });
        expect(JSON.stringify(opensslOut)).toContain(MEMORY_MARK);
        expect(JSON.stringify(opensslOut)).toMatch(/openssl/i);
        onOpenssl.close();
        const onSqlite = openMemory({ dir: join(dir, "sqlite") });
        onSqlite.observe([{ role: "user", content: "Use sqlite." }]);
        const sqliteOut = injectBodyThenObserveTools(onSqlite, {
          messages: [{ role: "user", content: "What sqlite database do we use?" }],
        });
        const sqliteBlob = JSON.stringify(sqliteOut);
        expect(sqliteBlob).toContain(MEMORY_MARK);
        expect(sqliteBlob).toMatch(/sqlite/i);
        onSqlite.close();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("omit gate lives in src/index.ts (M38)", () => {
  test("wrap may mention EDEN_MEMORY_MIN only when that file contains it; core gate is src/index.ts", () => {
    const wrapSrc = readFileSync(join(ROOT, "packages/wrap/src/tool-observe.ts"), "utf8");
    const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf8");
    expect(wrapSrc).toMatch(/EDEN_MEMORY_INJECT_LOG/);
    expect(wrapSrc).toMatch(/logInjectMetric\(body, next\)/);
    expect(wrapSrc).toMatch(/return next;/);
    expect(wrapSrc).not.toMatch(/if\s*\(.*junk.*\)\s*return body/);
    if (/EDEN_MEMORY_MIN|memoryInjectSilent/.test(wrapSrc)) {
      expect(indexSrc).toMatch(/EDEN_MEMORY_MIN/);
      expect(indexSrc).toMatch(/memoryInjectSilent/);
    }
    expect(indexSrc).toMatch(/\binject\s*\(/);
  });

  test("silence.ts imports MEMORY_MARK; does not fork the string", () => {
    const src = readFileSync(join(import.meta.dir, "silence.ts"), "utf8");
    expect(src).toMatch(/import \{ cueFor, MEMORY_MARK \} from \"\.\.\/\.\.\/src\/index\.ts\"/);
    expect(src).not.toMatch(/export const MEMORY_MARK = \"Eden Memory:\"/);
    expect(src).toMatch(/Do not omit/);
  });
});

describe("silenceNotes RESULTS block", () => {
  test("on-arm junk>0 is evidence for M38, not a WIN", () => {
    const dir = tmp("eden-m323-notes-");
    const job = join(dir, "job");
    const log = join(dir, "on.jsonl");
    try {
      writeTrial(
        job,
        "openssl-selfsigned-cert__a",
        "terminal-bench/openssl-selfsigned-cert",
        "2026-09-21T12:00:00.000Z",
        "2026-09-21T12:05:00.000Z",
      );
      writeFileSync(
        log,
        logLine({
          t: Date.parse("2026-09-21T12:01:00.000Z"),
          arm: "on",
          empty: false,
          n_notes: 5,
          junk: true,
          cue: OPENSSL_CUE,
          packet: SQLITE_PACKET,
        }) + "\n",
      );
      const md = silenceNotes({
        date: "2026-09-21",
        offJob: null,
        onJob: job,
        onLog: log,
        offLog: join(dir, "missing-off.jsonl"),
        accuracy_pp: -0.2,
      });
      expect(md).toContain("## Remain-silent measure");
      expect(md).toContain("Dated 2026-09-21");
      expect(md).toContain("junk");
      expect(md).toMatch(/on-arm junk=1/);
      expect(md).toContain("evidence for M38");
      expect(md).toContain("not a WIN");
      expect(md).toContain("omit gate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renderResults calls silenceNotes; default inject log path matches M32.1", () => {
    expect(defaultInjectLogPath("on")).toBe(injectLogPath("on"));
    expect(defaultInjectLogPath("off")).toBe(injectLogPath("off"));
    const md = renderResults({
      ...pendingResultsReport("2026-09-21"),
      delta: { accuracy_pp: -0.2, tokens_total: null, dollars: 0 },
    });
    expect(md).toContain("## Remain-silent measure");
    expect(md).not.toContain("pending M32.3");
    expect(md).toContain("evidence for M38");
    expect(md).toContain("Dated 2026-09-21");
  });
});
