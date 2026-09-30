import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveCli, approveHelp, promoteCli } from "./approve";
import { writeConfig } from "./home";

describe("eden approve", () => {
  let home: string;
  const prevHome = process.env.EDEN_HOME;

  beforeEach(() => {
    home = join(import.meta.dir, `../../.tmp-eden-approve-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true });
    process.env.EDEN_HOME = home;
    writeConfig({ api_key: "eden_dev", base_url: "http://127.0.0.1:8788" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });
  test("help forbids shipping without --yes", () => {
    expect(approveHelp()).toMatch(/Without --yes nothing turns On/);
    expect(approveHelp()).toMatch(/eden promote <id>/);
    expect(approveHelp()).toMatch(/canary/);
    expect(approveHelp()).toMatch(/FAIL \/ INCONCLUSIVE/);
    expect(approveHelp()).toMatch(/cannot ship/);
  });

  test("wrap down prints a sentence and does not throw", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      const code = await approveCli(["desk"], {
        fetch: (async () => {
          throw new Error("down");
        }) as unknown as typeof fetch,
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/wrap is down/);
    } finally {
      console.log = orig;
    }
  });

  test("without --yes prints the card and does not POST", async () => {
    let posted = 0;
    const code = await approveCli(["c1"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posted++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/v1/candidates/c1")) {
          return new Response(
            JSON.stringify({
              id: "c1",
              verdict: "PASS",
              sequence: ["search", "close"],
              program: { id: "c1", name: "desk_close", sequence: ["search", "close"], contract: { witnesses: 3 } },
              diff: null,
            }),
            { status: 200 },
          );
        }
        return new Response("no", { status: 404 });
      }) as typeof fetch,
    });
    expect(code).toBe(2);
    expect(posted).toBe(0);
  });

  async function captureApprove(
    args: string[],
    fetchFn: typeof fetch,
  ): Promise<{ code: number; out: string }> {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      const code = await approveCli(args, { fetch: fetchFn });
      return { code, out: logs.join("\n") };
    } finally {
      console.log = orig;
    }
  }

  test("no id: 0 of everything keeps a short letter plus eden explain", async () => {
    const { code, out } = await captureApprove([], (async () =>
      new Response(JSON.stringify({ candidates: [] }), { status: 200 })) as unknown as typeof fetch);
    expect(code).toBe(0);
    expect(out).toBe("approve: 0 PASS candidates\neden explain");
    expect(out).not.toMatch(/FAIL|INCONCLUSIVE/);
  });

  test("no id: 0 PASS still prints FAIL rows (cannot ship)", async () => {
    let posted = 0;
    const { code, out } = await captureApprove([], (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              id: "p_fail",
              verdict: "FAIL",
              program: { id: "p_fail", name: "lookupTicket_to_notify", sequence: ["lookupTicket"] },
              refusal: { reason: "not measured — quality held but neither tokens nor time saved", sequence: ["lookupTicket"] },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch);
    expect(code).toBe(0);
    expect(posted).toBe(0);
    expect(out).toMatch(/0 PASS candidates/);
    expect(out).toMatch(/cannot ship FAIL \/ INCONCLUSIVE/);
    expect(out).toMatch(/p_fail  FAIL  not measured — quality held but neither tokens nor time saved/);
    expect(out).not.toMatch(/eden explain/);
  });

  test("no id: 0 PASS still prints INCONCLUSIVE rows (cannot ship)", async () => {
    const { code, out } = await captureApprove([], (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              id: "p_maybe",
              verdict: "INCONCLUSIVE",
              program: { id: "p_maybe", name: "maybe", sequence: ["x"] },
              refusal: { reason: "only 1 of 3 held-out traces could validate this program", sequence: ["x"] },
            },
            {
              id: "p_fail",
              verdict: "FAIL",
              program: { id: "p_fail", name: "bad", sequence: ["x"] },
              refusal: { reason: "compiled output differs from the recorded trace", sequence: ["x"] },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch);
    expect(code).toBe(0);
    expect(out).toMatch(/p_maybe  INCONCLUSIVE  only 1 of 3 held-out traces could validate this program/);
    expect(out).toMatch(/p_fail  FAIL  compiled output differs from the recorded trace/);
    expect(out).toMatch(/cannot ship/);
  });

  test("no id: 0 PASS still prints pending rows (cannot ship)", async () => {
    const { code, out } = await captureApprove([], (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              id: "p_wait",
              verdict: "pending",
              program: { id: "p_wait", name: "lookupTicket_to_notify", sequence: ["lookupTicket"] },
              refusal: { reason: "uncovered: lookupTicket, writeRecord, notify", sequence: ["lookupTicket"] },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch);
    expect(code).toBe(0);
    expect(out).toMatch(/0 PASS candidates/);
    expect(out).toMatch(/cannot ship/);
    expect(out).toMatch(/p_wait  pending  uncovered: lookupTicket, writeRecord, notify/);
    expect(out).not.toMatch(/eden explain/);
  });

  test("FAIL cannot be shipped even with --yes", async () => {
    let posted = 0;
    const code = await approveCli(["bad", "--yes"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "bad",
            verdict: "FAIL",
            sequence: ["x"],
            program: { id: "bad", name: "bad", sequence: ["x"] },
            refusal: { reason: "weak", sequence: ["x"] },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(code).toBe(1);
    expect(posted).toBe(0);
  });

  test("INCONCLUSIVE cannot be shipped even with --yes", async () => {
    let posted = 0;
    const code = await approveCli(["maybe", "--yes"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted++;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "maybe",
            verdict: "INCONCLUSIVE",
            sequence: ["x"],
            program: { id: "maybe", name: "maybe", sequence: ["x"] },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(code).toBe(1);
    expect(posted).toBe(0);
  });

  test("--yes POSTs approve for a PASS candidate", async () => {
    let posted = "";
    const code = await approveCli(["c1", "--yes"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          posted = url;
          return new Response(JSON.stringify({ ok: true, name: "desk_close" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "c1",
            verdict: "PASS",
            sequence: ["search", "close"],
            program: { id: "c1", name: "desk_close", sequence: ["search", "close"], contract: { witnesses: 3 } },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(posted).toMatch(/\/v1\/tools\/c1\/approve/);
  });

  test("--writes without EDEN_TRANSPARENT_WRITES does not send the flag", async () => {
    const prev = process.env.EDEN_TRANSPARENT_WRITES;
    delete process.env.EDEN_TRANSPARENT_WRITES;
    let body = "";
    await approveCli(["c1", "--yes", "--writes"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          body = String(init.body ?? "");
          return new Response(JSON.stringify({ ok: true, name: "w" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "c1",
            verdict: "PASS",
            program: { id: "c1", name: "w", sequence: ["Write"] },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(body).not.toMatch(/transparent_writes/);
    if (prev === undefined) delete process.env.EDEN_TRANSPARENT_WRITES;
    else process.env.EDEN_TRANSPARENT_WRITES = prev;
  });

  test("card includes envelope line and llm badge", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      await approveCli(["c1"], {
        fetch: (async () =>
          new Response(
            JSON.stringify({
              id: "c1",
              verdict: "PASS",
              sequence: ["search", "close"],
              program: {
                id: "c1",
                name: "desk_close",
                sequence: ["search", "close"],
                steps: [],
                contract: { witnesses: 3, envelope: { inputs: { id: ["T-1", "T-2"] } } },
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      });
    } finally {
      console.log = orig;
    }
    const card = logs.join("\n");
    expect(card).toContain("Envelope · 1 key · 2 values");
    expect(card).toContain("Zero-LLM");
    expect(card).toContain("Canary · 10% of sessions until promote.");
  });

  test("--yes ships canary with no extra flag; --live sets rollout live", async () => {
    let body = "";
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      await approveCli(["c1", "--yes"], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST") {
            body = String(init.body ?? "");
            return new Response(JSON.stringify({ ok: true, name: "desk_close" }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              id: "c1",
              verdict: "PASS",
              program: { id: "c1", name: "desk_close", steps: [], contract: { envelope: { inputs: { id: ["T-1"] } } } },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });
    } finally {
      console.log = orig;
    }
    expect(body).not.toMatch(/rollout/);
    expect(logs.join("\n")).toContain("approved desk_close · Canary · 10% of sessions");
    expect(logs.join("\n")).toContain("eden promote c1");

    body = "";
    logs.length = 0;
    console.log = (m?: unknown) => {
      logs.push(String(m ?? ""));
    };
    try {
      await approveCli(["c1", "--yes", "--live"], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST") {
            body = String(init.body ?? "");
            return new Response(JSON.stringify({ ok: true, name: "desk_close" }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              id: "c1",
              verdict: "PASS",
              program: { id: "c1", name: "desk_close", steps: [] },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(body)).toMatchObject({ rollout: "live" });
    expect(logs.join("\n")).toContain("approved desk_close · Live");
  });

  test("--pin sends pinIslands on approve", async () => {
    let body = "";
    await approveCli(["c1", "--yes", "--pin"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          body = String(init.body ?? "");
          return new Response(JSON.stringify({ ok: true, name: "desk_close" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "c1",
            verdict: "PASS",
            program: { id: "c1", name: "desk_close", steps: [] },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(JSON.parse(body)).toMatchObject({ pinIslands: true });
  });

  test("eden promote POSTs /v1/tools/:id/promote", async () => {
    let posted = "";
    const code = await promoteCli(["tool_1"], {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = String(input);
          return new Response(JSON.stringify({ ok: true, rollout: "live" }), { status: 200 });
        }
        return new Response("no", { status: 404 });
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(posted).toMatch(/\/v1\/tools\/tool_1\/promote/);
  });
});
