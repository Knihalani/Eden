import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importHelp, importTraces, IMPORT_USAGE } from "./import";
import { writeConfig } from "./home";
import { edenHelp } from "./cli";

const dir = join(import.meta.dir, "../../.tmp-eden-import-traces");
const examples = join(import.meta.dir, "../../../examples/compile-traces");

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    errs.push(String(msg ?? ""));
  };
  try {
    const code = await fn();
    return { code, out: logs.join("\n"), err: errs.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("eden import", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;
  const prevDev = process.env.EDEN_DEV;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-import-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_DEV = "1";
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevDev === undefined) delete process.env.EDEN_DEV;
    else process.env.EDEN_DEV = prevDev;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("help names --traces and --file, does not Approve", async () => {
    const help = importHelp();
    expect(help).toMatch(/eden import --traces/);
    expect(help).toMatch(/--file/);
    expect(help).toMatch(/Does not Approve/);
    expect(help).toMatch(/eden approve/);
    expect(help).toMatch(/does not ship/);
    expect(help).not.toMatch(/\/dashboard|\/workshop/);
    const { code, out } = await capture(() => importTraces(["--help"]));
    expect(code).toBe(0);
    expect(out).toBe(help);
    expect(edenHelp()).toMatch(/import\s+Send traces to wrap/);
  });

  test("missing args: usage on stderr, exit 1", async () => {
    const { code, out, err } = await capture(() => importTraces([]));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(IMPORT_USAGE);
  });

  test("--traces without a path exits 2 with one stderr sentence", async () => {
    const { code, out, err } = await capture(() => importTraces(["--traces"]));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/--traces is required/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("empty directory: one sentence, exit 0", async () => {
    const empty = `${dir}-empty`;
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    try {
      const { code, out, err } = await capture(() => importTraces(["--traces", empty]));
      expect(code).toBe(0);
      expect(out).toBe("");
      expect(err).toMatch(/Nothing to import/);
      expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("missing traces path is nothing to import, not a crash", async () => {
    const { code, err } = await capture(() => importTraces(["--traces", join(dir, "does-not-exist")]));
    expect(code).toBe(0);
    expect(err).toMatch(/Nothing to import/);
  });

  test("bad JSON exits 1 with one stderr sentence", async () => {
    const folder = `${dir}-bad-json`;
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "bad.json"), "{not json");
    try {
      const { code, out, err } = await capture(() => importTraces(["--traces", folder]));
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toMatch(/not valid JSON/);
      expect(err).toMatch(/eden import:/);
      expect(err).not.toMatch(/eden compile:/);
      expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("wrap down: one stderr sentence, no stack dump", async () => {
    const { code, out, err } = await capture(() =>
      importTraces(["--traces", join(examples, "repeating")], {
        fetch: (async () => {
          throw new Error("connect ECONNREFUSED");
        }) as unknown as typeof fetch,
      }),
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("import: wrap is down · start eden wrap");
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).not.toMatch(/ECONNREFUSED|Error:|at /);
  });

  test("--traces POSTs /v1/traces and does not Approve", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const { code, out, err } = await capture(() =>
      importTraces(["--traces", join(examples, "repeating")], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          urls.push(url);
          methods.push(init?.method ?? "GET");
          if (url.endsWith("/v1/candidates")) {
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    id: "p_fail",
                    verdict: "FAIL",
                    refusal: { reason: "not measured — quality held but neither tokens nor time saved" },
                  },
                ],
              }),
              { status: 200 },
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as { traces?: unknown[] };
          expect(Array.isArray(body.traces)).toBe(true);
          expect(body.traces!.length).toBe(3);
          return new Response(JSON.stringify({ ok: true, accepted: body.traces!.length }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe("http://127.0.0.1:8788/v1/traces");
    expect(urls[1]).toBe("http://127.0.0.1:8788/v1/candidates");
    expect(methods).toEqual(["POST", "GET"]);
    expect(urls.some((u) => u.includes("approve"))).toBe(false);
    expect(out).toMatch(/Imported 3\/3 traces/);
    expect(out).toMatch(/Does not Approve/);
    expect(out).toMatch(/Wrap minted a candidate/);
    expect(out).toMatch(/Read the verdict/);
    expect(out).toMatch(/does not ship/);
    expect(out).toMatch(/eden approve/);
    expect(out).not.toMatch(/eden play/);
    expect(out).not.toMatch(/\/dashboard|\/workshop/);
  });

  test("--traces with no wrap candidates points at explain, not play", async () => {
    const { code, out } = await capture(() =>
      importTraces(["--traces", join(examples, "repeating")], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith("/v1/candidates")) {
            return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true, accepted: 3 }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/Imported 3\/3 traces/);
    expect(out).toMatch(/eden explain/);
    expect(out).not.toMatch(/eden play/);
  });

  test("--file still posts LangSmith/OTel/JSONL and does not say dashboard", async () => {
    const file = join(dir, "export.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ name: "lookupTicket", args: { id: "T-1" }, ok: true })}\n`);
    const urls: string[] = [];
    const { code, out, err } = await capture(() =>
      importTraces(["--file", file], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          urls.push(String(input));
          if (String(input).endsWith("/v1/candidates")) {
            return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
          }
          expect(init?.method).toBe("POST");
          return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(urls).toEqual(["http://127.0.0.1:8788/v1/traces", "http://127.0.0.1:8788/v1/candidates"]);
    expect(out).toMatch(/Detected generic_jsonl/);
    expect(out).toMatch(/Imported 1\/1 traces/);
    expect(out).toMatch(/Does not Approve/);
    expect(out).toMatch(/eden explain/);
    expect(out).not.toMatch(/eden play/);
    expect(out).not.toMatch(/dashboard|workshop/i);
  });

  test("--traces and --file together: one stderr sentence", async () => {
    const { code, err } = await capture(() => importTraces(["--traces", "a", "--file", "b"]));
    expect(code).toBe(2);
    expect(err).toMatch(/use --traces or --file, not both/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
  });
});
