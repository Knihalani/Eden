import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  demoCli,
  demoHelp,
  demoChildEnv,
  DEMO_MISSING,
  DEMO_REL,
  parseInbox,
  parseLiveTools,
  pickPlayTool,
  resolveDemoScript,
  demoPortBusyMessage,
  demoListenLines,
  demoListenFooter,
} from "./demo";

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

describe("eden demo", () => {
  test("help is a letter: Approves TicketShip (operator), not compile; T-100; stays up; exit 0", async () => {
    const letter = demoHelp();
    expect(letter).toMatch(/^eden demo —/);
    expect(letter).toMatch(/TicketShip/);
    expect(letter).toMatch(/T-100/);
    expect(letter).toMatch(/stay up|stays up/);
    expect(letter).toMatch(/The demo script Approves TicketShip \(operator\)/);
    expect(letter).toMatch(/Does not Approve/);
    expect(letter).toMatch(/eden compile/);
    expect(letter).toMatch(/bun run demo/);
    expect(letter).toMatch(DEMO_REL);
    expect(letter).toMatch(/does not start the server/);
    expect(letter).toMatch(/eden_dev|EDEN_DEV/);
    expect(letter).toMatch(/PORT|8788/);
    expect(letter).toMatch(/EDEN_WRAP_URL/);
    expect(letter).toMatch(/\/v1\/inbox/);
    expect(letter).not.toMatch(/\/live/);

    const { code, out, err } = await capture(() => demoCli(["--help"]));
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(letter);

    const missing = await capture(() => demoCli(["--help"], { scriptPath: "/no/such/apps/control/src/demo.ts" }));
    expect(missing.code).toBe(0);
    expect(missing.out).toMatch(/TicketShip/);
  });

  test("missing clone path: one stderr sentence, exit 1", async () => {
    const { code, out, err } = await capture(() => demoCli([], { scriptPath: "/no/such/apps/control/src/demo.ts" }));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(DEMO_MISSING);
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(err).toMatch(/missing clone path/);
    expect(err).toMatch(/apps\/control\/src\/demo\.ts/);
  });

  test("resolveDemoScript finds the TicketShip script in this clone without starting it", () => {
    const found = resolveDemoScript();
    expect(found).toBeTruthy();
    expect(found).toMatch(new RegExp(`${DEMO_REL.replaceAll("/", "\\/")}$`));
    expect(existsSync(found!)).toBe(true);
  });

  test("resolveDemoScript prefers a sibling demo.js so npm i -g does not need a clone", () => {
    const dir = join(tmpdir(), `eden-demo-bundle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const bundled = join(dir, "demo.js");
    writeFileSync(bundled, "/* bundle */\n");
    try {
      expect(resolveDemoScript("/no/such/cwd", dir)).toBe(bundled);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown flag exits 2 with one stderr sentence and does not start the server", async () => {
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      return { exited: Promise.resolve(0) };
    };
    const { code, out, err } = await capture(() => demoCli(["--certified"], { spawn }));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe("eden demo: unknown flag --certified");
    expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    expect(spawned).toBe(0);

    const live = await capture(() => demoCli(["--live"], { spawn }));
    expect(live.code).toBe(2);
    expect(live.err).toBe("eden demo: unknown flag --live");
    expect(spawned).toBe(0);

    const helpFirst = await capture(() => demoCli(["--help", "--certified"], { spawn }));
    expect(helpFirst.code).toBe(0);
    expect(helpFirst.out).toBe(demoHelp());
    expect(helpFirst.err).toBe("");
    expect(spawned).toBe(0);
  });

  test("spawn uses local eden_dev unless EDEN_API_KEY is already set", async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const spawn: import("./demo").DemoSpawn = (_cmd, opts) => {
      env = opts.env;
      return { exited: Promise.resolve(0) };
    };
    const script = resolveDemoScript();
    expect(script).toBeTruthy();
    const { code } = await capture(() => demoCli([], { scriptPath: script, spawn }));
    expect(code).toBe(0);
    expect(env?.EDEN_DEV).toBe("1");
    expect(env?.EDEN_API_KEY).toBe("eden_dev");
    const kept = demoChildEnv({ EDEN_API_KEY: "sk-real" });
    expect(kept.EDEN_API_KEY).toBe("sk-real");
    expect(kept.EDEN_DEV).toBeUndefined();
  });
});

describe("parseInbox", () => {
  test("auth refuse is a demo: sentence, not a TypeError, and not a PASS", () => {
    const r = parseInbox({ error: "unauthorized" });
    expect(r.candidates).toEqual([]);
    expect(r.notice).toBe("demo: /v1/inbox unauthorized");
    expect(r.notice!.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.candidates.find((c) => c.verdict === "PASS" && c.program)).toBeUndefined();
  });

  test("port in use is one stderr sentence naming wrap or PORT", () => {
    const msg = demoPortBusyMessage(8788);
    expect(msg).toBe("demo: port 8788 is in use · stop eden wrap or set PORT");
    expect(msg.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("sitting banner names health and play, not HTML /live that 404s", () => {
    const up = demoListenLines("http://127.0.0.1:8799/", "eden_dev");
    expect(up).toMatch(/http:\/\/127\.0\.0\.1:8799\/health/);
    expect(up).toMatch(/\/v1\/inbox/);
    expect(up).toMatch(/EDEN_WRAP_URL=http:\/\/127\.0\.0\.1:8799/);
    expect(up).not.toMatch(/\/live\b/);
    expect(up).not.toMatch(/http:\/\/127\.0\.0\.1:8799\/\s*$/m);
    const foot = demoListenFooter("http://127.0.0.1:8799/", "eden_dev");
    expect(foot).toMatch(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8799\/v1/);
    expect(foot).toMatch(/compiled hit/);
    expect(foot).toMatch(/HTTP 200/);
    expect(foot).toMatch(/\/v1\/wrap/);
    expect(foot).toMatch(/\/v1\/ingest/);
    expect(foot).not.toMatch(/press c/);
    expect(foot).not.toMatch(/apps\/web/);
  });

  test("the play hint passes --key eden_dev to the demo and does not repeat an operator key", () => {
    const dev = demoListenLines("http://127.0.0.1:8799/", "eden_dev");
    expect(dev).toMatch(/eden play <name> --key eden_dev --input/);
    const own = demoListenLines("http://127.0.0.1:8799/", "eden_operator_key");
    expect(own).toMatch(/eden play <name> --input/);
    expect(own).not.toMatch(/--key/);
  });

  test("missing candidates is a demo: sentence and empty list", () => {
    const r = parseInbox({ heartbeat: 1, live: [] });
    expect(r.candidates).toEqual([]);
    expect(r.notice).toBe("demo: /v1/inbox is not a candidates object");
  });

  test("malformed body and null candidates do not throw", () => {
    for (const body of [null, undefined, "nope", 401, [], { candidates: null }, { candidates: "x" }]) {
      const r = parseInbox(body);
      expect(r.candidates).toEqual([]);
      expect(r.notice).toMatch(/^demo: /);
      expect(r.notice!.split("\n").filter(Boolean)).toHaveLength(1);
    }
  });

  test("empty candidates is compile mined nothing, not an error", () => {
    const r = parseInbox({ candidates: [] });
    expect(r.notice).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.candidates.find((c) => c.verdict === "PASS")).toBeUndefined();
  });

  test("leftover live tool is played; empty store still skips T-100", () => {
    expect(pickPlayTool({ id: "p_new", program: { name: "fresh" } }, [{ id: "p_old" }])).toEqual({
      id: "p_new",
      name: "fresh",
      reused: false,
    });
    expect(pickPlayTool(undefined, [{ id: "p_live", name: "lookupTicket_to_notify" }])).toEqual({
      id: "p_live",
      name: "lookupTicket_to_notify",
      reused: true,
    });
    expect(pickPlayTool(undefined, [])).toBeNull();
    expect(parseLiveTools({ tools: [{ id: "p_1", name: "a" }, { nope: true }] })).toEqual([{ id: "p_1", name: "a" }]);
    expect(parseLiveTools({ error: "unauthorized" })).toEqual([]);
  });

  test("a real PASS candidate is returned; holes in the list are dropped", () => {
    const r = parseInbox({
      candidates: [null, { id: "p", verdict: "PASS", program: { name: "lookupTicket_to_notify" } }, "x"],
    });
    expect(r.notice).toBeNull();
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates.find((c) => c.verdict === "PASS" && c.program)?.program?.name).toBe("lookupTicket_to_notify");
  });
});
