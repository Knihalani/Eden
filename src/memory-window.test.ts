import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptHash } from "./memory-turn";
import { appendTurn, cronHashes, humanTurns, recordCrons, transcriptOffset, windowDir } from "./memory-window";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-window-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a window lives at <root>/windows/<win>, and an unsafe window key has none", () => {
  expect(windowDir("/m", "s1")).toBe("/m/windows/s1");
  expect(windowDir("/m", "s1--a1b2")).toBe("/m/windows/s1--a1b2");
  expect(windowDir("/m", "../etc")).toBeUndefined();
  expect(windowDir("/m", "a/b")).toBeUndefined();
  expect(windowDir("/m", "")).toBeUndefined();
});

describe("A4 §4: turn records and hturn", () => {
  test("hturn counts distinct prompt_ids, so a repeated Submit counts once", () => {
    const win = windowDir(root(), "s1")!;
    expect(humanTurns(win)).toBe(0);
    appendTurn(win, { promptId: "p1", prompt: "fix the login", off: 0 });
    appendTurn(win, { promptId: "p1", prompt: "fix the login", off: 0 });
    appendTurn(win, { promptId: "p2", prompt: "now the logout", off: 812 });
    expect(humanTurns(win)).toBe(2);
    const lines = readFileSync(join(win, "delivery.log"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[2]!)).toEqual({ k: "turn", prompt_id: "p2", off: 812 });
    expect(statSync(join(win, "delivery.log")).mode & 0o777).toBe(0o600);
  });

  test("without a prompt_id, the prompt's hash and the offset key the record, never the text", () => {
    const win = windowDir(root(), "s1")!;
    appendTurn(win, { prompt: "fix the login", off: 10 });
    appendTurn(win, { prompt: "fix the login", off: 10 });
    appendTurn(win, { prompt: "fix the login", off: 99 });
    expect(humanTurns(win)).toBe(2);
    expect(readFileSync(join(win, "delivery.log"), "utf8")).not.toContain("login");
  });

  test("a torn last line is skipped", () => {
    const win = windowDir(root(), "s1")!;
    appendTurn(win, { promptId: "p1", prompt: "a", off: 0 });
    writeFileSync(join(win, "delivery.log"), '{"k":"turn","prompt_id":"p2"', { flag: "a" });
    expect(humanTurns(win)).toBe(1);
  });

  test("the offset is the transcript's size, or 0 without one", () => {
    const dir = root();
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "x".repeat(37));
    expect(transcriptOffset(path)).toBe(37);
    expect(transcriptOffset(join(dir, "missing.jsonl"))).toBe(0);
    expect(transcriptOffset("")).toBe(0);
  });
});

describe("D24: the crons of the window's last Stop", () => {
  const cron = (prompt: string) => ({ id: "c", schedule: "*/5 * * * *", recurring: true, prompt });

  test("kept as hashes, replaced by the next Stop that differs, appended only on a change", () => {
    const win = windowDir(root(), "s1")!;
    expect(cronHashes(win)).toEqual([]);
    recordCrons(win, [cron("check the deploy"), cron("check the deploy")]);
    expect(cronHashes(win)).toEqual([promptHash("check the deploy")]);
    recordCrons(win, [cron("check the deploy")]);
    expect(readFileSync(join(win, "ctx.log"), "utf8").trim().split("\n")).toHaveLength(1);
    recordCrons(win, []);
    expect(cronHashes(win)).toEqual([]);
    expect(readFileSync(join(win, "ctx.log"), "utf8")).not.toContain("deploy");
  });

  test("a Stop without session_crons, or with malformed entries, changes nothing", () => {
    const win = windowDir(root(), "s1")!;
    recordCrons(win, [cron("check the deploy")]);
    recordCrons(win, undefined);
    recordCrons(win, "check the deploy");
    expect(cronHashes(win)).toEqual([promptHash("check the deploy")]);
    recordCrons(win, [null, { prompt: 7 }, { prompt: "  " }]);
    expect(cronHashes(win)).toEqual([]);
  });
});
