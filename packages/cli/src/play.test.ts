import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { edenHelp } from "./cli";
import { INIT_NEXT_STEPS, init, initHelp } from "./init";
import { parsePlayInput, playCli, playHelp, PLAY_USAGE } from "./play";
import { writeConfig } from "./home";

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const stdout: string[] = [];
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (msg?: unknown) => {
    logs.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    errs.push(String(msg ?? ""));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out: [...logs, ...stdout].join(""), err: errs.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}

describe("eden play", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;
  const prevDev = process.env.EDEN_DEV;
  const prevWrap = process.env.EDEN_WRAP_URL;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-play-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(join(home, "runs"), { recursive: true });
    process.env.EDEN_HOME = home;
    process.env.EDEN_DEV = "1";
    delete process.env.EDEN_WRAP_URL;
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevDev === undefined) delete process.env.EDEN_DEV;
    else process.env.EDEN_DEV = prevDev;
    if (prevWrap === undefined) delete process.env.EDEN_WRAP_URL;
    else process.env.EDEN_WRAP_URL = prevWrap;
    rmSync(home, { recursive: true, force: true });
  });

  test("missing name: one stderr sentence, exit 1", async () => {
    const { code, out, err } = await capture(() => playCli([]));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(PLAY_USAGE);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).toMatch(/--input/);
    expect(err).not.toMatch(/--ids 11,12/);
  });

  test("help names generic --input", () => {
    expect(playHelp()).toMatch(/--input/);
    expect(playHelp()).toMatch(/wrap-run/);
    expect(playHelp()).toMatch(/--ids/);
    expect(playHelp()).toMatch(/EDEN_WRAP_URL/);
  });

  test("wrap down: one stderr sentence, exit 1, no throw", async () => {
    const { code, err } = await capture(() =>
      playCli(["desk", "--input", "{}"], {
        fetch: (async () => {
          throw new Error("connect ECONNREFUSED");
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/wrap is down/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).not.toMatch(/ECONNREFUSED|TypeError|at /);
  });

  test("--input posts wrap /v1/wrap-run with toolId and input", async () => {
    let url = "";
    let body = "";
    const { code, out } = await capture(() =>
      playCli(["lookupTicket_to_notify", "--input", '{"id":"T-1"}'], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          url = String(input);
          body = String(init?.body ?? "");
          return new Response(JSON.stringify({ ok: true, value: { id: "T-1" } }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(url).toMatch(/\/v1\/wrap-run$/);
    const parsed = JSON.parse(body) as { toolId: string; input: { id: string }; program: { name: string } };
    expect(parsed.toolId).toBe("lookupTicket_to_notify");
    expect(parsed.input).toEqual({ id: "T-1" });
    expect(parsed.program.name).toBe("lookupTicket_to_notify");
    expect(out).toMatch(/T-1/);
    expect(out).not.toMatch(/"ok"\s*:|"stats"\s*:/);
  });

  test("EDEN_WRAP_URL beats config so play can hit a demo sitting on PORT", async () => {
    process.env.EDEN_WRAP_URL = "http://127.0.0.1:8799";
    let url = "";
    const { code } = await capture(() =>
      playCli(["lookupTicket_to_notify", "--input", '{"id":"T-100"}'], {
        fetch: (async (input: string | URL | Request) => {
          url = String(input);
          return new Response(JSON.stringify({ ok: true, value: { notified: true, id: "T-100" } }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(url).toBe("http://127.0.0.1:8799/v1/wrap-run");
  });

  test("--input file posts the file JSON", async () => {
    const file = join(home, "in.json");
    writeFileSync(file, JSON.stringify({ cart: "CART-0" }));
    let body = "";
    const { code } = await capture(() =>
      playCli(["cart", "--input", file], {
        fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
          body = String(init?.body ?? "");
          return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(body).input).toEqual({ cart: "CART-0" });
  });

  test("--ids still posts GitHub-shaped /v1/play", async () => {
    let url = "";
    let body = "";
    const { code } = await capture(() =>
      playCli(["github_pr_bundle", "--ids", "11,12"], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          url = String(input);
          body = String(init?.body ?? "");
          return new Response(JSON.stringify({ ok: true, table: "ok\n" }), { status: 200 });
        }) as typeof fetch,
      }),
    );
    expect(code).toBe(0);
    expect(url).toMatch(/\/v1\/play$/);
    expect(JSON.parse(body).ids).toBe("11,12");
  });

  test("parsePlayInput reads objects and rejects arrays", () => {
    expect(parsePlayInput('{"id":"T-1"}')).toEqual({ id: "T-1" });
    expect(parsePlayInput(undefined)).toEqual({});
    expect(() => parsePlayInput("[1]")).toThrow(/JSON object/);
  });

  test("not live: one stderr sentence naming Approve as the On switch, not a JSON dump", async () => {
    const { code, out, err } = await capture(() =>
      playCli(["lookupTicket_to_notify", "--input", '{"id":"T-1"}'], {
        fetch: (async () => new Response(JSON.stringify({ error: "not live" }), { status: 404 })) as typeof fetch,
      }),
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/not live/);
    expect(err).toMatch(/Approve/);
    expect(err).toMatch(/On switch/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).not.toMatch(/\{|"error"/);
  });

  test("paused: one stderr sentence, not a JSON dump", async () => {
    const { code, out, err } = await capture(() =>
      playCli(["desk", "--input", "{}"], {
        fetch: (async () =>
          new Response(JSON.stringify({ error: "paused", program: "desk" }), { status: 409 })) as typeof fetch,
      }),
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/paused/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).not.toMatch(/\{|"error"/);
  });

  test("no registry: one stderr sentence, not a JSON dump", async () => {
    const { code, out, err } = await capture(() =>
      playCli(["desk", "--input", "{}"], {
        fetch: (async () => new Response(JSON.stringify({ error: "no registry" }), { status: 409 })) as typeof fetch,
      }),
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(/no registry/);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).not.toMatch(/\{|"error"/);
  });
});

describe("person path copy", () => {
  test("root help is git-grouped and names compile plus play --input", () => {
    const help = edenHelp();
    expect(help).toMatch(/^usage: eden /);
    expect(help).toMatch(/compile traces into a tool/i);
    expect(help.indexOf("compile")).toBeLessThan(help.indexOf("hookd"));
    expect(help).toMatch(/eden compile|--traces/);
    expect(help).toMatch(/--input/);
    expect(help).toMatch(/Does not Approve/);
    expect(help).toMatch(/import\s+Send traces to wrap/);
    expect(help).toMatch(/help -a/);
    expect(help).not.toMatch(/^\s+audit export/m);
    expect(help).toMatch(/^\s+demo\s+/m);
    expect(help).toMatch(/bun run demo/);
    expect(help).toMatch(/TicketShip/);
    expect(help).toMatch(/T-100/);
    expect(help.split("\n").find((l) => /^\s+demo\s+/.test(l))!.length).toBeLessThanOrEqual(80);
    expect(help).not.toMatch(/\/dashboard|\/workshop/);
  });

  test("init next-steps name compile, explain, approve, play", () => {
    expect(INIT_NEXT_STEPS).toMatch(/eden compile --traces/);
    expect(INIT_NEXT_STEPS).toMatch(/examples\/compile-traces/);
    expect(INIT_NEXT_STEPS).toMatch(/eden import --traces/);
    expect(INIT_NEXT_STEPS).toMatch(/eden explain/);
    expect(INIT_NEXT_STEPS).toMatch(/eden approve/);
    expect(INIT_NEXT_STEPS).toMatch(/--yes/);
    expect(INIT_NEXT_STEPS).toMatch(/eden play/);
    expect(INIT_NEXT_STEPS).toMatch(/--input/);
    expect(INIT_NEXT_STEPS).toMatch(/eden demo/);
    expect(INIT_NEXT_STEPS).toMatch(/bun run demo/);
    expect(INIT_NEXT_STEPS).toMatch(/TicketShip/);
    expect(INIT_NEXT_STEPS).toMatch(/\/v1\/wrap/);
    expect(INIT_NEXT_STEPS).toMatch(/OPENAI_API_KEY/);
    expect(INIT_NEXT_STEPS).toMatch(/eden memory import/);
    expect(INIT_NEXT_STEPS).toMatch(/EDEN_MEMORY/);
    expect(INIT_NEXT_STEPS).not.toMatch(/\/dashboard|\/workshop/);
  });

  test("init --help is a letter and does not write config or install hooks", async () => {
    expect(initHelp()).toMatch(/^eden init —/);
    expect(initHelp()).toMatch(/does not write config/);
    expect(initHelp()).toMatch(/Does not Approve/);
    expect(initHelp()).toMatch(/eden compile --traces/);
    expect(initHelp()).toMatch(/eden demo/);
    expect(initHelp()).not.toMatch(/setting up/);

    const { code, out, err } = await capture(() => init(["--help"]));
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(initHelp());
    expect(out).not.toMatch(/setting up|hooks installed/);

    const empty = join(import.meta.dir, `../../.tmp-eden-init-help-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(empty, { recursive: true });
    const prev = process.env.EDEN_HOME;
    process.env.EDEN_HOME = empty;
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "init", "--help"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, EDEN_HOME: empty },
      });
      const text = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(text.trimEnd()).toBe(initHelp().trimEnd());
      expect(existsSync(join(empty, "config.json"))).toBe(false);
    } finally {
      process.env.EDEN_HOME = prev;
      rmSync(empty, { recursive: true, force: true });
    }

    const dashH = await capture(() => init(["-h"]));
    expect(dashH.code).toBe(0);
    expect(dashH.out).toBe(initHelp());
  });
});
