import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourcesFromEnv, staticSources } from "./connectors";
import { SourceConfigError } from "./user-sources";

const dir = mkdtempSync(join(tmpdir(), "eden-conn-"));
let n = 0;
const write = (body: unknown) => {
  const p = join(dir, `s${++n}.json`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};
const doc = { ref: "r", title: "t", text: "x" };
const ok = { id: "ok", description: "fine", docs: [doc] };
/** The `SourceConfigError` message `staticSources` throws on this file body. */
const rejection = (body: unknown): string => {
  try {
    staticSources(write(body));
  } catch (e) {
    expect(e).toBeInstanceOf(SourceConfigError);
    return (e as Error).message;
  }
  throw new Error("staticSources accepted the file");
};

describe("EDEN_SOURCES_FILE validation", () => {
  test("a valid file loads its sources", () => {
    const sources = staticSources(write({ sources: [ok, { id: "b", description: "", docs: [] }] }));
    expect(sources.map((s) => s.id)).toEqual(["ok", "b"]);
  });

  test("{} and other shapes without a sources array are refused, naming the expected shape", () => {
    for (const body of [{}, [], "null", { sources: {} }, { sources: "x" }]) {
      expect(rejection(body)).toMatch(/^EDEN_SOURCES_FILE must be \{"sources": \[/);
    }
  });

  test("a bad id is refused, naming the entry", () => {
    expect(rejection({ sources: [ok, { id: "bad id!", description: "x", docs: [] }] })).toBe(
      "EDEN_SOURCES_FILE.sources[1].id must be 1-128 characters of [A-Za-z0-9._:@-]",
    );
  });

  test("a missing or non-string id is refused, naming the entry", () => {
    expect(rejection({ sources: [{ description: "x", docs: [] }] })).toMatch(/^EDEN_SOURCES_FILE\.sources\[0\]\.id /);
    expect(rejection({ sources: [{ id: 7, description: "x", docs: [] }] })).toMatch(/sources\[0\]\.id must be/);
  });

  test("a duplicate id is refused, naming the second entry", () => {
    expect(rejection({ sources: [ok, { ...ok, description: "again" }] })).toBe(
      'EDEN_SOURCES_FILE.sources[1].id "ok" is listed twice',
    );
  });

  test("a non-string ref, title or text is refused, naming the entry and the document", () => {
    for (const bad of [{ ...doc, ref: 1 }, { ...doc, title: null }, { ref: "r", title: "t" }, "doc"]) {
      expect(rejection({ sources: [ok, { id: "c", description: "x", docs: [doc, bad] }] })).toBe(
        "EDEN_SOURCES_FILE.sources[1].docs[1] needs string ref, title and text",
      );
    }
  });

  test("a missing docs is refused, naming the entry and pointing at EDEN_USER_SOURCES_FILE (D108)", () => {
    const msg = rejection({ sources: [ok, { id: "mail", description: "m", url: "https://x" }] });
    expect(msg).toMatch(/^EDEN_SOURCES_FILE sources\[1\] has no docs.*EDEN_USER_SOURCES_FILE \(D108\)$/);
    expect(rejection({ sources: [ok, { id: "mail", description: "m", docs: "x" }] })).toMatch(/sources\[1\] has no/);
  });

  test("a non-object entry or a missing description is refused, naming the entry", () => {
    expect(rejection({ sources: [ok, "calendar"] })).toBe("EDEN_SOURCES_FILE.sources[1] must be an object");
    expect(rejection({ sources: [{ id: "a", docs: [] }] })).toBe(
      "EDEN_SOURCES_FILE.sources[0].description must be a string",
    );
  });

  test("an entry cannot pass as an MCP source: every shared entry is checked as static", () => {
    const mcp = { kind: "mcp", id: "m", description: "x", url: "https://x", docs: [doc] };
    expect(staticSources(write({ sources: [mcp] })).map((s) => s.id)).toEqual(["m"]);
    expect(rejection({ sources: [{ ...mcp, docs: [{ ref: 1 }] }] })).toMatch(/sources\[0\]\.docs\[0\] needs/);
  });

  test("bad JSON and an unreadable file are a SourceConfigError that does not quote the file", () => {
    const msg = rejection('{"sources": [{"id": "a", "token": sk-secret}]}');
    expect(msg).toMatch(/^EDEN_SOURCES_FILE \S+ is not valid JSON$/);
    expect(msg).not.toContain("sk-secret");
    expect(() => staticSources(join(dir, "missing.json"))).toThrow(SourceConfigError);
    expect(() => staticSources(join(dir, "missing.json"))).toThrow(/^EDEN_SOURCES_FILE \S+ cannot be read/);
  });

  test("unset reads nothing; sourcesFromEnv reports the shared count", async () => {
    expect(staticSources(undefined)).toEqual([]);
    expect(staticSources("")).toEqual([]);
    const loaded = sourcesFromEnv({ EDEN_SOURCES_FILE: write({ sources: [ok] }) });
    expect(loaded.shared).toBe(1);
    expect((await loaded.resolver({ tenantId: "t", userId: "u" })).map((s) => s.id)).toEqual(["ok"]);
    expect(sourcesFromEnv({}).shared).toBe(0);
  });
});

describe("a bad EDEN_SOURCES_FILE stops the servers with one line and exit 2", () => {
  const run = (entry: string, file: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, entry)], {
      // EDEN_PROCESSES=1: the exit and its one line are the server's own, not a router's over N children (the default
      // since D178 is the core count, and scripts/test-preload.ts clears EDEN_*, so it would otherwise apply).
      env: { ...process.env, EDEN_SOURCES_FILE: file, EDEN_DEV: "1", PORT: "0", EDEN_PROCESSES: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: 20_000,
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };
  const bad = () => write({ sources: [{ id: "bad id!", description: "x", docs: [] }] });

  for (const entry of ["main.ts", "mcp-stdio.ts"]) {
    test(`${entry}: a bad entry, {} and bad JSON exit 2 with the message and no stack`, () => {
      const env = { EDEN_TENANT: "acme", EDEN_USER: "u1" };
      for (const [file, msg] of [
        [bad(), "EDEN_SOURCES_FILE.sources[0].id must be"],
        [write({}), 'EDEN_SOURCES_FILE must be {"sources"'],
        [write("{nope"), "is not valid JSON"],
      ] as const) {
        const r = run(entry, file, env);
        expect(r.code).toBe(2);
        expect(r.out).toBe("");
        expect(r.err).toContain(msg);
        expect(r.err.trim().split("\n")).toHaveLength(1);
        expect(r.err).not.toMatch(/\n\s+at |\^|connectors\.ts/);
      }
    }, 70_000);
  }
});
