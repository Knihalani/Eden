import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StretchProgram } from "@eden/ir";
import {
  GENESIS,
  Store,
  chainRecords,
  createHandler,
  exportAudit,
  hashPayload,
  neutralizeCsvField,
  parseAccessReview,
  parseAudit,
  recordsFromStore,
  restoreCsvField,
  sanitizeJson,
  serializeAudit,
  verifyAccessReview,
  verifyAudit,
} from "@eden/control";
import { auditCli, auditHelp, runExport, runReview, runVerify } from "./audit";

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  if (PREV_DEV === undefined) delete process.env.EDEN_DEV;
  else process.env.EDEN_DEV = PREV_DEV;
});

function program(id: string, version = "v1"): StretchProgram {
  return {
    id,
    version,
    name: `tool ${id}`,
    description: "",
    inputSchema: { type: "object" },
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
    manifest: null,
  };
}

function seedStore(path = ":memory:"): Store {
  const store = new Store(path);
  store.putTool({
    id: "tool_1",
    name: "lookup_issue",
    version: "v1",
    program: program("tool_1", "v1"),
    state: "live",
    prev: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  });
  store.putTool({
    id: "tool_1",
    name: "lookup_issue",
    version: "v2",
    program: program("tool_1", "v2"),
    state: "live",
    prev: [program("tool_1", "v1")],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
  });
  store.putReceipt({
    id: "rcp_1",
    tool_id: "tool_1",
    version: "v2",
    ms: 40,
    llm_calls: 0,
    cents: 0,
    ok: 1,
    created_at: 1_700_000_200_000,
  });
  store.putCandidate({
    id: "ref_1",
    sequence: ["Write", "Bash"],
    program: null,
    refusal: { sequence: ["Write", "Bash"], reason: "underdetermined_write" },
    verdict: "FAIL",
    manifest: null,
    created_at: 1_700_000_050_000,
  });
  return store;
}

describe("audit export schema", () => {
  test("covers approvals, versions, executions, and refusals", () => {
    const records = recordsFromStore(seedStore());
    const kinds = new Set(records.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["approval", "version", "execution", "refusal"]));
    expect(records[0]!.prev).toBe(GENESIS);
    expect(records.every((r, i) => r.seq === i + 1)).toBe(true);
    for (let i = 1; i < records.length; i++) {
      expect(records[i]!.prev).toBe(records[i - 1]!.sha256);
    }
  });

  test("version timestamps are the live era, not export time, so they sort before later executions", () => {
    const records = recordsFromStore(seedStore());
    const version = records.find((r) => r.kind === "version");
    const execution = records.find((r) => r.kind === "execution");
    expect(version?.at).toBe(1_700_000_000_000);
    expect(execution?.at).toBe(1_700_000_200_000);
    expect(version!.at).toBeLessThan(execution!.at);
    const ats = records.map((r) => r.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  test("jsonl and csv round-trip to the same records and hashes", () => {
    const original = recordsFromStore(seedStore());
    const jsonl = serializeAudit(original, "jsonl");
    const csv = serializeAudit(original, "csv");
    const fromJsonl = parseAudit(jsonl, "jsonl");
    const fromCsv = parseAudit(csv, "csv");
    expect(fromJsonl).toEqual(original);
    expect(fromCsv).toEqual(original);
    expect(fromCsv.map((r) => r.sha256)).toEqual(fromJsonl.map((r) => r.sha256));
    expect(verifyAudit(jsonl).ok).toBe(true);
    expect(verifyAudit(csv).ok).toBe(true);
  });
});

describe("tamper-evident chain", () => {
  test("verify accepts a clean file", () => {
    const text = exportAudit(seedStore(), "jsonl");
    const result = verifyAudit(text);
    expect(result).toEqual({ ok: true, n: parseAudit(text).length });
  });

  test("splicing a line fails verify", () => {
    const text = exportAudit(seedStore(), "jsonl");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(2);
    const spliced = [...lines.slice(0, 1), ...lines.slice(2)].join("\n") + "\n";
    const result = verifyAudit(spliced);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  test("flipping a byte fails verify", () => {
    const text = exportAudit(seedStore(), "jsonl");
    const i = text.indexOf("lookup_issue");
    expect(i).toBeGreaterThan(0);
    const flipped = text.slice(0, i) + "X" + text.slice(i + 1);
    expect(verifyAudit(flipped).ok).toBe(false);
  });

  test("missing prev fails closed", () => {
    const rec = chainRecords([
      {
        kind: "approval",
        id: "a1",
        at: 1,
        tool_id: "t",
        name: "n",
        version: "v1",
        state: "live",
        verdict: "",
        reason: "",
        ok: "",
      },
    ])[0]!;
    const { prev: _prev, ...rest } = rec;
    const line = JSON.stringify({ ...rest, sha256: rec.sha256 });
    const result = verifyAudit(line + "\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/prev/);
  });

  test("empty export verifies", () => {
    expect(verifyAudit("")).toEqual({ ok: true, n: 0 });
    expect(verifyAudit("seq,kind,id,at,tool_id,name,version,state,verdict,reason,ok,prev,sha256\n")).toEqual({
      ok: true,
      n: 0,
    });
  });
});

describe("red-team: hostile fields", () => {
  test("CSV injection in fields round-trips and does not execute as a formula in the file", () => {
    const hostile = "=cmd|' /C calc'!A0";
    const records = chainRecords([
      {
        kind: "refusal",
        id: hostile,
        at: 9,
        tool_id: "+1+1",
        name: "@SUM(1+1)",
        version: "\t-1+1",
        state: "",
        verdict: "FAIL",
        reason: hostile,
        ok: "",
      },
    ]);
    const csv = serializeAudit(records, "csv");
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+1+1");
    expect(csv).toContain("'@SUM");
    expect(csv.split("\n")[1]).not.toMatch(/^[=+\-@]/);
    const back = parseAudit(csv, "csv");
    expect(back[0]!.id).toBe(hostile);
    expect(back[0]!.tool_id).toBe("+1+1");
    expect(back[0]!.reason).toBe(hostile);
    expect(verifyAudit(csv).ok).toBe(true);
    expect(neutralizeCsvField(hostile).startsWith("'")).toBe(true);
    expect(restoreCsvField(neutralizeCsvField(hostile))).toBe(hostile);
  });

  test("__proto__ in a JSONL line stays data and does not pollute", () => {
    const rec = chainRecords([
      {
        kind: "approval",
        id: "a1",
        at: 1,
        tool_id: "t",
        name: "n",
        version: "v1",
        state: "live",
        verdict: "",
        reason: "",
        ok: "",
      },
    ])[0]!;
    const hostile = `{"__proto__":{"polluted":true},${JSON.stringify(rec).slice(1)}`;
    const parsed = parseAudit(hostile + "\n");
    expect(parsed).toHaveLength(1);
    expect(verifyAudit(hostile + "\n").ok).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed[0], "polluted")).toBe(false);
    const cleaned = sanitizeJson(JSON.parse('{"__proto__":{"polluted":true},"keep":1}'));
    expect(Object.getPrototypeOf(cleaned)).toBeNull();
    expect((cleaned as { keep: number }).keep).toBe(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("GET /v1/audit", () => {
  test("writes jsonl and csv that verify", async () => {
    const store = seedStore();
    const handler = createHandler({ store, token: "eden_dev" });
    const jsonlRes = await handler(
      new Request("http://x/v1/audit?format=jsonl", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(jsonlRes.status).toBe(200);
    const jsonl = await jsonlRes.text();
    expect(verifyAudit(jsonl)).toEqual({ ok: true, n: parseAudit(jsonl).length });
    const csvRes = await handler(
      new Request("http://x/v1/audit?format=csv", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(csvRes.headers.get("content-type")).toMatch(/csv/);
    expect(verifyAudit(await csvRes.text()).ok).toBe(true);
  });

  test("refuses without a key and does not 500 on a bad format", async () => {
    const handler = createHandler({ store: seedStore(), token: "eden_dev" });
    const denied = await handler(new Request("http://x/v1/audit"));
    expect(denied.status).toBe(401);
    const bad = await handler(
      new Request("http://x/v1/audit?format=xlsx", { headers: { authorization: "Bearer eden_dev" } }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("eden audit CLI", () => {
  test("help lists export and review", () => {
    expect(auditHelp()).toContain("eden audit export");
    expect(auditHelp()).toContain("eden audit review");
    expect(auditHelp()).toContain("--format jsonl");
    expect(auditHelp()).toContain("csv");
    expect(auditHelp()).toContain("jq");
    expect(auditHelp()).toContain("spreadsheet");
  });

  test("export --help and audit --help print usage, not an empty export", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      expect(await auditCli(["--help"])).toBe(0);
      expect(await auditCli(["export", "--help"])).toBe(0);
      expect(await auditCli(["review", "--help"])).toBe(0);
      expect(await auditCli(["verify", "--help"])).toBe(0);
    } finally {
      console.log = orig;
    }
    const joined = lines.join("\n");
    expect(joined).toContain("eden audit export");
    expect(joined).toContain("eden audit review");
    expect(joined).toContain("eden audit verify");
    expect(joined).not.toMatch(/^{/);
  });

  test("export --format jsonl and csv from a store, then verify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-audit-"));
    const db = join(dir, "control.sqlite");
    seedStore(db);

    const jsonlPath = join(dir, "audit.jsonl");
    const csvPath = join(dir, "audit.csv");
    expect(await auditCli(["export", "--format", "jsonl", "--store", db, "--out", jsonlPath])).toBe(0);
    expect(await auditCli(["export", "--format", "csv", "--store", db, "--out", csvPath])).toBe(0);
    expect(runVerify(readFileSync(jsonlPath, "utf8")).ok).toBe(true);
    expect(runVerify(readFileSync(csvPath, "utf8")).ok).toBe(true);
    expect(await auditCli(["verify", jsonlPath])).toBe(0);
    expect(await auditCli(["verify", csvPath])).toBe(0);

    const spliced = join(dir, "spliced.jsonl");
    const lines = readFileSync(jsonlPath, "utf8").trimEnd().split("\n");
    writeFileSync(spliced, [...lines.slice(0, 1), ...lines.slice(2)].join("\n") + "\n");
    expect(await auditCli(["verify", spliced])).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("review --format jsonl and csv from a store, then verify; tamper fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-review-"));
    const db = join(dir, "control.sqlite");
    seedStore(db);

    const jsonlPath = join(dir, "review.jsonl");
    const csvPath = join(dir, "review.csv");
    expect(await auditCli(["review", "--format", "jsonl", "--store", db, "--out", jsonlPath])).toBe(0);
    expect(await auditCli(["review", "--format", "csv", "--store", db, "--out", csvPath])).toBe(0);
    const jsonl = readFileSync(jsonlPath, "utf8");
    expect(runVerify(jsonl).ok).toBe(true);
    expect(verifyAccessReview(jsonl).ok).toBe(true);
    expect(parseAccessReview(jsonl)[0]!.who).toBe("operator");
    expect(parseAccessReview(jsonl)[0]!.version).toBeTruthy();
    expect(await auditCli(["verify", jsonlPath])).toBe(0);
    expect(await auditCli(["verify", csvPath])).toBe(0);

    const spliced = join(dir, "spliced-review.jsonl");
    const i = jsonl.indexOf("lookup_issue");
    expect(i).toBeGreaterThan(0);
    writeFileSync(spliced, jsonl.slice(0, i) + "X" + jsonl.slice(i + 1));
    expect(await auditCli(["verify", spliced])).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("cli.ts help text names the command", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "help", "-a"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toMatch(/^\s+audit export/m);
    expect(out).toMatch(/^\s+audit review/m);
    expect(out).toMatch(/^\s+audit verify/m);
    expect(out).not.toContain("eden audit export");
    expect(out).not.toContain("eden audit review");
    expect(out).not.toContain("eden audit verify");
  });

  test("runExport from --store does not throw into the caller on a missing file", async () => {
    await expect(runExport(["--store", join(tmpdir(), "no-such-eden-store.sqlite")])).rejects.toThrow(/no store/);
  });

  test("review HTTP 403 does not dump local sqlite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-review-403-"));
    const prevHome = process.env.EDEN_HOME;
    const prevFetch = globalThis.fetch;
    process.env.EDEN_HOME = dir;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" }));
    seedStore(join(dir, "control.sqlite"));
    globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    try {
      await expect(runReview(["--url", "http://127.0.0.1:9"])).rejects.toThrow(/HTTP 403/);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hash covers canonical payload plus prev", () => {
  test("changing prev without rewriting sha256 fails", () => {
    const rec = chainRecords([
      {
        kind: "approval",
        id: "a",
        at: 1,
        tool_id: "t",
        name: "n",
        version: "v",
        state: "live",
        verdict: "",
        reason: "",
        ok: "",
      },
    ])[0]!;
    const tampered = { ...rec, prev: "a".repeat(64) };
    expect(verifyAudit(JSON.stringify(tampered) + "\n").ok).toBe(false);
    expect(hashPayload({ seq: 1, kind: "approval", id: "a", at: 1, tool_id: "t", name: "n", version: "v", state: "live", verdict: "", reason: "", ok: "" }, GENESIS).length).toBe(64);
  });
});
