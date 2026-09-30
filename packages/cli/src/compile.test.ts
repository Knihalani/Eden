import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StretchTrace } from "@eden/ir";
import { collectCompile, compileCli, compileHelp, formatCompile, formatCompileJson } from "./compile";
import { edenHelp, edenHelpAdvanced } from "./cli";

const dir = join(import.meta.dir, "../../.tmp-eden-compile-traces");

function trace(
  id: string,
  names: string[],
  input: Record<string, unknown>,
  extra?: (i: number) => StretchTrace["events"][number]["args"],
): StretchTrace {
  return {
    id,
    llmCalls: names.length,
    duration_ms: names.length * 10,
    cost_cents: names.length,
    complete: true,
    input,
    events: names.map((name, i) => ({
      name,
      args: extra ? extra(i) : { ...input },
      result: { ok: true, ...input },
      ok: true,
    })),
  };
}

function writeTraces(folder: string, traces: StretchTrace[]): void {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const t of traces) writeFileSync(join(folder, `${t.id}.json`), JSON.stringify(t));
}

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

function repeatingTraces(n = 3): StretchTrace[] {
  return Array.from({ length: n }, (_, i) =>
    trace(`r${i}`, ["lookupTicket", "writeRecord", "notify"], { id: `T-${i}` }),
  );
}

function uniqueWorkTraces(): StretchTrace[] {
  return [
    trace("u0", ["alpha", "bravo", "charlie"], { id: "U-0" }),
    trace("u1", ["delta", "echo", "foxtrot"], { id: "U-1" }),
    trace("u2", ["golf", "hotel", "india"], { id: "U-2" }),
  ];
}

function underdeterminedTraces(): StretchTrace[] {
  return Array.from({ length: 3 }, (_, i) =>
    trace(`w${i}`, ["lookupTicket", "writeRecord", "notify"], { id: `T-${i}` }, (step) =>
      step === 1 ? { id: `OTHER-${i}` } : { id: `T-${i}` },
    ),
  );
}

/** Cart traces that compile to a foreach over items. Inlined — not a horizon import. */
function cartLoopTraces(): StretchTrace[] {
  return Array.from({ length: 4 }, (_, i) => {
    const items = [
      { sku: `a${i}`, qty: 1 },
      { sku: `b${i}`, qty: 2 },
      { sku: `c${i}`, qty: 1 },
    ];
    const cart = `CART-${i}`;
    return {
      id: `cart${i}`,
      llmCalls: 5,
      duration_ms: 50,
      cost_cents: 5,
      complete: true,
      input: { cart },
      events: [
        { name: "listCart", args: { cart }, result: { items, cart }, ok: true },
        ...items.map((it) => ({
          name: "reserveSku",
          args: { sku: it.sku },
          result: { reserved: it.sku },
          ok: true,
        })),
        { name: "checkoutCart", args: { cart }, result: { paid: true }, ok: true },
      ],
    };
  });
}

describe("eden compile", () => {
  test("help names traces, refusals, and turns-saved; exits 0", async () => {
    const help = compileHelp();
    expect(help).toMatch(/eden compile/);
    expect(help).toMatch(/--traces/);
    expect(help).toMatch(/named refusals|Refusals/i);
    expect(help).toMatch(/turns-saved/);
    expect(help).toMatch(/Does not Approve/);
    expect(help).toMatch(/foreach/);
    expect(help).toMatch(/branch/);
    expect(help).toMatch(/poll/);
    expect(help).toMatch(/cursor/);
    expect(help).toMatch(/offset/);
    expect(help).toMatch(/^Empty traces: nothing to compile, exit 0\./m);
    expect(help).not.toMatch(/present\. Empty traces/);
    expect(help).not.toMatch(/certified|live path/i);
    const { code, out } = await capture(() => compileCli(["--help"]));
    expect(code).toBe(0);
    expect(out).toBe(help);
    expect(await compileCli(["-h"])).toBe(0);
  });

  test("missing --traces prints the usage letter and exits 2", async () => {
    const { code, out, err } = await capture(() => compileCli([]));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain(compileHelp());
    expect(err).toMatch(/--traces is required/);
  });

  test("unknown flag exits 2 with one stderr sentence and does not crash", async () => {
    const { code, out, err } = await capture(() => compileCli(["--certified"]));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/unknown flag --certified/);
    const live = await capture(() => compileCli(["--live"]));
    expect(live.code).toBe(2);
    expect(live.err).toMatch(/unknown flag --live/);
    const approve = await capture(() => compileCli(["--traces", dir, "--approve"]));
    expect(approve.code).toBe(2);
    expect(approve.err).toMatch(/unknown flag --approve/);
  });

  test("bad JSON exits 1 with one stderr sentence", async () => {
    const folder = `${dir}-bad-json`;
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "bad.json"), "{not json");
    try {
      const { code, out, err } = await capture(() => compileCli(["--traces", folder]));
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toMatch(/not valid JSON/);
      expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("empty directory: one sentence, exit 0", async () => {
    const empty = `${dir}-empty`;
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    try {
      const { code, out, err } = await capture(() => compileCli(["--traces", empty]));
      expect(code).toBe(0);
      expect(out).toBe("");
      expect(err).toMatch(/Nothing to compile/);
      expect(err.split("\n").filter(Boolean)).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("missing traces path is nothing to compile, not a crash", async () => {
    const { code, err } = await capture(() => compileCli(["--traces", join(dir, "does-not-exist")]));
    expect(code).toBe(0);
    expect(err).toMatch(/Nothing to compile/);
  });

  test("unique-work traces: 0 programs, not a fake win", () => {
    const report = collectCompile(uniqueWorkTraces());
    expect(report.programs).toEqual([]);
    expect(report.turnsSaved).toBe(0);
    expect(report.uniqueWork).toBe(true);
    const letter = formatCompile(report);
    expect(letter).toMatch(/0 programs/);
    expect(letter).toMatch(/Unique work/);
    expect(letter).toMatch(/not a compile win/);
    expect(letter).not.toMatch(/certified|\blive\b/i);
    expect(letter).toMatch(/turns-saved estimate: 0/);
  });

  test("repeating traces print name, sequence, and turns-saved estimate", () => {
    const report = collectCompile(repeatingTraces());
    expect(report.programs.length).toBeGreaterThan(0);
    expect(report.uniqueWork).toBe(false);
    const p = report.programs[0]!;
    expect(p.sequence.join(" ")).toMatch(/lookupTicket/);
    expect(p.sequence.join(" ")).toMatch(/notify/);
    expect(p.compiledTurns).toBe(1);
    expect(p.naiveEvents).toBeGreaterThanOrEqual(3);
    expect(p.turnsSaved).toBe(p.naiveEvents - 1);
    const letter = formatCompile(report);
    expect(letter).toMatch(new RegExp(`${report.programs.length} program`));
    expect(letter).toContain(p.name);
    expect(letter).toContain(p.sequence.join(" → "));
    expect(letter).toMatch(/turns-saved estimate/);
    expect(letter).not.toMatch(/Approve|certified/);
    expect(letter).not.toMatch(/foreach|branch on|poll until/);
    expect(p.shape).toEqual([]);
  });

  test("--json prints the same facts as the letter", async () => {
    const folder = `${dir}-json`;
    writeTraces(folder, repeatingTraces());
    try {
      const letter = await capture(() => compileCli(["--traces", folder]));
      const jsonRun = await capture(() => compileCli(["--traces", folder, "--json"]));
      expect(letter.code).toBe(0);
      expect(jsonRun.code).toBe(0);
      const body = JSON.parse(jsonRun.out) as {
        programs: Array<{
          name: string;
          sequence: string[];
          naiveEvents: number;
          compiledTurns: number;
          turnsSaved: number;
        }>;
        refusals: unknown[];
        turnsSaved: number;
        uniqueWork: boolean;
      };
      expect(body.programs.length).toBeGreaterThan(0);
      expect(letter.out).toContain(body.programs[0]!.name);
      expect(letter.out).toContain(body.programs[0]!.sequence.join(" → "));
      expect(letter.out).toMatch(/turns-saved estimate/);
      expect(body.turnsSaved).toBe(body.programs.reduce((s, p) => s + p.turnsSaved, 0));
      expect(formatCompileJson(collectCompile(repeatingTraces()))).toContain(body.programs[0]!.name);
      expect(jsonRun.out).not.toMatch(/Next:|eden play|eden approve|eden explain|eden import/);
      expect(body).not.toHaveProperty("next");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("underdetermined writes print the documented Refusal.code word", () => {
    const report = collectCompile(underdeterminedTraces());
    expect(report.programs).toEqual([]);
    expect(report.refusals.some((r) => r.code === "underdetermined_write")).toBe(true);
    const letter = formatCompile(report);
    expect(letter).toMatch(/underdetermined_write/);
    expect(letter).toMatch(/0 programs/);
  });

  test("cli plumbing: help, empty, bad flags, unique-work, compile", async () => {
    expect(await compileCli(["--help"])).toBe(0);
    const empty = `${dir}-plumb-empty`;
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    try {
      expect(await compileCli(["--traces", empty])).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(await compileCli([])).toBe(2);
    expect(await compileCli(["--nope"])).toBe(2);

    const uniq = `${dir}-unique`;
    writeTraces(uniq, uniqueWorkTraces());
    try {
      const { code, out } = await capture(() => compileCli(["--traces", uniq]));
      expect(code).toBe(0);
      expect(out).toMatch(/0 programs/);
      expect(out).toMatch(/Unique work/);
    } finally {
      rmSync(uniq, { recursive: true, force: true });
    }

    const ok = `${dir}-ok`;
    writeTraces(ok, repeatingTraces());
    try {
      const { code, out } = await capture(() => compileCli(["--traces", ok]));
      expect(code).toBe(0);
      expect(out).toMatch(/program/);
      expect(out).toMatch(/→/);
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  });

  test("root help lists eden compile on the first-screen compile path", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    expect(text).toMatch(/eden compile|--traces/);
    expect(text).toMatch(/compile traces into a tool/i);
    expect(text).toMatch(/--input/);
    expect(text).toMatch(/bun run demo/);
    expect(text).toMatch(/TicketShip/);
    expect(text).toMatch(/^\s+login /m);
    expect(edenHelp()).toMatch(/Does not Approve/);
    expect(edenHelp()).toMatch(/bun run demo/);
    expect(edenHelp()).toMatch(/^\s+login /m);
    expect(edenHelp()).toMatch(/^\s+mcp /m);
    expect(edenHelp()).toMatch(/help -a/);
    expect(edenHelp()).not.toMatch(/^\s+audit export/m);
    expect(edenHelpAdvanced()).toMatch(/^\s+audit export/m);
    expect(edenHelpAdvanced()).toMatch(/^\s+mcp /m);
    expect(edenHelpAdvanced()).not.toMatch(/eden audit export/);
    expect(text).not.toMatch(/^\s+audit export/m);

    const advanced = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "help", "-a"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const all = await new Response(advanced.stdout).text();
    expect(await advanced.exited).toBe(0);
    expect(all).toMatch(/^\s+audit export/m);
    expect(all).toMatch(/^\s+know run/m);
  });

  test("unknown command is one stderr sentence, not a help dump", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), "nope"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(out.trim()).toBe("");
    expect(err.trim()).toBe("eden: 'nope' is not an eden command. See 'eden --help'.");
  });

  test("shipped examples/compile-traces compile, refuse, and name foreach", async () => {
    const examples = join(import.meta.dir, "../../../examples/compile-traces");
    const readme = await Bun.file(join(examples, "README.md")).text();
    expect(readme).toMatch(/repeating/);
    expect(readme).toMatch(/unique/);
    expect(readme).toMatch(/foreach/);
    expect(readme).toMatch(/refuse/);
    expect(readme).toMatch(/branch/);
    expect(readme).toMatch(/poll/);
    expect(readme).toMatch(/cursor/);
    expect(readme).toMatch(/offset/);
    expect(readme).toMatch(/eden compile --traces/);
    expect(readme).toMatch(/eden import --traces/);
    expect(readme).toMatch(/bun run demo/);
    expect(readme).toMatch(/TicketShip|T-100/);
    expect(readme).toMatch(/FAIL \/ INCONCLUSIVE|until shadow certifies/);
    expect(readme).not.toMatch(/\/dashboard|\/workshop/);

    const repeating = await capture(() => compileCli(["--traces", join(examples, "repeating")]));
    expect(repeating.code).toBe(0);
    expect(repeating.out).toMatch(/program/);
    expect(repeating.out).toMatch(/lookupTicket → writeRecord → notify/);
    expect(repeating.out).not.toMatch(/Approve/);
    expect(repeating.out).toMatch(/eden import --traces/);
    expect(repeating.out).toMatch(/eden approve/);
    expect(repeating.out).toMatch(/read the verdict; cannot ship FAIL \/ INCONCLUSIVE/);
    expect(repeating.out).not.toMatch(/eden play/);
    const r0 = JSON.parse(await Bun.file(join(examples, "repeating/r0.json")).text()) as {
      output?: unknown;
      events: Array<{ result?: unknown }>;
    };
    expect(r0.output).toEqual(r0.events.at(-1)?.result);

    const unique = await capture(() => compileCli(["--traces", join(examples, "unique")]));
    expect(unique.code).toBe(0);
    expect(unique.out).toMatch(/0 programs/);
    expect(unique.out).toMatch(/Unique work/);
    expect(unique.out).toMatch(/eden explain/);
    expect(unique.out).not.toMatch(/eden play/);
    expect(unique.out).not.toMatch(/eden import/);

    const foreach = await capture(() => compileCli(["--traces", join(examples, "foreach")]));
    expect(foreach.code).toBe(0);
    expect(foreach.out).toMatch(/foreach/);
    expect(foreach.out).toMatch(/listCart → foreach reserveSku → checkoutCart/);
    expect(foreach.out).not.toMatch(/reserveSku → reserveSku → reserveSku/);
    expect(foreach.out).toMatch(/5 naive events → 1 compiled/);
    expect(foreach.out).toMatch(/eden approve/);
    expect(foreach.out).not.toMatch(/eden play/);

    const branch = await capture(() => compileCli(["--traces", join(examples, "branch")]));
    expect(branch.code).toBe(0);
    expect(branch.out).toMatch(/branch on sev/);
    expect(branch.out).not.toMatch(/kind:\s*"branch"/);
    expect(branch.out).toMatch(/eden approve/);

    const poll = await capture(() => compileCli(["--traces", join(examples, "poll")]));
    expect(poll.code).toBe(0);
    expect(poll.out).toMatch(/poll until ready/);
    expect(poll.out).not.toMatch(/getRollout → getRollout → getRollout/);
    expect(poll.out).toMatch(/eden approve/);

    const cursor = await capture(() => compileCli(["--traces", join(examples, "cursor")]));
    expect(cursor.code).toBe(0);
    expect(cursor.out).toMatch(/cursor pages until next is empty/);
    expect(cursor.out).not.toMatch(/kind:\s*"loop"/);
    expect(cursor.out).toMatch(/eden approve/);

    const offset = await capture(() => compileCli(["--traces", join(examples, "offset")]));
    expect(offset.code).toBe(0);
    expect(offset.out).toMatch(/offset pages until the last page/);
    expect(offset.out).not.toMatch(/kind:\s*"loop"/);
    expect(offset.out).toMatch(/eden approve/);

    const refuse = await capture(() => compileCli(["--traces", join(examples, "refuse")]));
    expect(refuse.code).toBe(0);
    expect(refuse.out).toMatch(/underdetermined_write/);
    expect(refuse.out).toMatch(/0 programs/);
    expect(refuse.out).toMatch(/eden explain/);
    expect(refuse.out).not.toMatch(/eden play/);
    expect(refuse.out).not.toMatch(/eden import/);
  });

  test("README first screen names compile --traces and not deleted workshop chrome", async () => {
    const readme = await Bun.file(join(import.meta.dir, "../../../README.md")).text();
    const head = readme.slice(0, 1800);
    expect(head).toMatch(/eden compile --traces/);
    expect(head).toMatch(/@kaiavn\/eden/);
    expect(head).toMatch(/examples\/compile-traces/);
    expect(head).not.toMatch(/\/dashboard/);
    expect(head).not.toMatch(/\/workshop/);
    expect(readme).toMatch(/eden import --traces/);
    expect(readme).toMatch(/eden play/);
    expect(readme).toMatch(/--input/);
    expect(readme).toMatch(/Does not Approve|does not Approve/);
    expect(readme).toMatch(/does not mint a wrap candidate/i);
    expect(readme).toMatch(/bun run demo/);
    expect(readme).toMatch(/TicketShip/);
    expect(readme).toMatch(/FAIL \/ INCONCLUSIVE|until shadow certifies/);
    expect(readme).toMatch(/eden mcp --help/);
    expect(readme).toMatch(/Sequential single-call turns do not benefit/);
  });

  test("letter and json name a foreach when traces compile to a loop", async () => {
    const report = collectCompile(cartLoopTraces());
    expect(report.programs.length).toBeGreaterThan(0);
    expect(report.uniqueWork).toBe(false);
    expect(report.shape).toContain("loop");
    const p = report.programs[0]!;
    expect(p.shape).toContain("loop");
    const letter = formatCompile(report);
    expect(letter).toMatch(/foreach over items/);
    expect(letter).toContain(p.name);
    expect(p.sequence).toEqual(["listCart", "foreach reserveSku", "checkoutCart"]);
    expect(p.naiveEvents).toBe(5);
    expect(p.turnsSaved).toBe(4);
    expect(letter).toMatch(/listCart → foreach reserveSku → checkoutCart/);
    expect(letter).not.toMatch(/reserveSku → reserveSku → reserveSku/);
    expect(letter).toMatch(/5 naive events → 1 compiled \(4 saved\)/);
    expect(letter).toMatch(/turns-saved estimate/);
    expect(letter).not.toMatch(/kind:\s*"loop"|LoopStep|"over":/);
    const body = JSON.parse(formatCompileJson(report)) as {
      programs: Array<{
        name: string;
        sequence: string[];
        naiveEvents: number;
        compiledTurns: number;
        turnsSaved: number;
        shape: string[];
      }>;
      refusals: unknown[];
      turnsSaved: number;
      uniqueWork: boolean;
      shape: string[];
    };
    expect(body.programs).toBeDefined();
    expect(body.refusals).toBeDefined();
    expect(typeof body.turnsSaved).toBe("number");
    expect(typeof body.uniqueWork).toBe("boolean");
    expect(body.shape).toContain("loop");
    expect(body.programs[0]!.shape).toContain("loop");
    expect(body.programs[0]!.sequence).toEqual(["listCart", "foreach reserveSku", "checkoutCart"]);
    expect(body.programs[0]!.naiveEvents).toBe(5);

    const folder = `${dir}-loop`;
    writeTraces(folder, cartLoopTraces());
    try {
      const run = await capture(() => compileCli(["--traces", folder]));
      expect(run.code).toBe(0);
      expect(run.out).toMatch(/foreach over items/);
      const jsonRun = await capture(() => compileCli(["--traces", folder, "--json"]));
      expect(jsonRun.code).toBe(0);
      const cliBody = JSON.parse(jsonRun.out) as { shape: string[] };
      expect(cliBody.shape).toContain("loop");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("letter names a 3-arm branch in one line and does not dump IR", () => {
    const traces: StretchTrace[] = [];
    const arms: Array<{ sev: string; tools: [string, string]; ids: number[] }> = [
      { sev: "p0", tools: ["createPage", "sendAckPage"], ids: [10, 11, 12] },
      { sev: "p1", tools: ["createTicket", "sendAckTicket"], ids: [20, 21, 22] },
      { sev: "p2", tools: ["writeLog", "sendAckLog"], ids: [30, 31, 32] },
    ];
    for (const arm of arms) {
      for (const [i, id] of arm.ids.entries()) {
        const alert = `al-${id}`;
        traces.push({
          id: `${arm.sev}-${i}`,
          llmCalls: 3,
          duration_ms: 30,
          cost_cents: 3,
          complete: true,
          input: { id },
          events: [
            { name: "getAlert", args: { id }, result: { sev: arm.sev, alert }, ok: true },
            { name: arm.tools[0], args: { alert }, result: { acked: true, alert }, ok: true },
            { name: arm.tools[1], args: { alert }, result: { done: true, alert }, ok: true },
          ],
        });
      }
    }
    const report = collectCompile(traces);
    expect(report.programs.length).toBeGreaterThan(0);
    expect(report.shape).toContain("branch");
    const p = report.programs[0]!;
    expect(p.shape).toContain("branch");
    const letter = formatCompile(report);
    expect(letter).toMatch(/branch on sev/);
    expect(letter.match(/branch on /g)?.length).toBe(1);
    expect(letter).toMatch(/getAlert → branch/);
    expect(letter).not.toMatch(/kind:\s*"branch"|BranchStep|"cases":/);
    const body = JSON.parse(formatCompileJson(report)) as { shape: string[] };
    expect(body.shape).toContain("branch");
  });

  test("letter names cursor pages when traces compile to a cursor walk", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `cur${i}`,
      llmCalls: 16,
      duration_ms: 40,
      cost_cents: 8,
      complete: true,
      input: { batch: `C${i}` },
      events: [
        {
          name: "listPage",
          args: { cursor: null, batch: `C${i}` },
          result: { items: ["P-a", "P-b"], nextCursor: "1" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "1", batch: `C${i}` },
          result: { items: ["P-c", "P-d"], nextCursor: "2" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "2", batch: `C${i}` },
          result: { items: ["P-e", "P-f"], nextCursor: null },
          ok: true,
        },
        ...["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"].flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `C${i}` }, result: { sealed: true }, ok: true },
      ],
    }));
    const report = collectCompile(traces);
    expect(report.shape).toContain("cursor");
    const letter = formatCompile(report);
    expect(letter).toMatch(/cursor pages until next is empty/);
    expect(letter).toMatch(/cursor listPage/);
    expect(letter).not.toMatch(/listPage → listPage → listPage/);
    expect(letter).not.toMatch(/kind:\s*"loop"|nextCursor/);
  });

  test("letter names offset pages when traces compile to a page/limit walk", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `off${i}`,
      llmCalls: 10,
      duration_ms: 40,
      cost_cents: 8,
      complete: true,
      input: { project: `gl-${i}` },
      events: [
        {
          name: "listIssues",
          args: { project: `gl-${i}`, page: 1, limit: 2 },
          result: { items: [{ iid: 1 }, { iid: 2 }], page: 1, limit: 2, totalPages: 3 },
          ok: true,
        },
        {
          name: "listIssues",
          args: { project: `gl-${i}`, page: 2, limit: 2 },
          result: { items: [{ iid: 3 }, { iid: 4 }], page: 2, limit: 2, totalPages: 3 },
          ok: true,
        },
        {
          name: "listIssues",
          args: { project: `gl-${i}`, page: 3, limit: 2 },
          result: { items: [{ iid: 5 }, { iid: 6 }], page: 3, limit: 2, totalPages: 3 },
          ok: true,
        },
        ...[1, 2, 3, 4, 5, 6].map((iid) => ({
          name: "commentIssue",
          args: { project: `gl-${i}`, iid },
          result: { commented: true, iid },
          ok: true,
        })),
        { name: "closeBoard", args: { project: `gl-${i}` }, result: { closed: true }, ok: true },
      ],
    }));
    const report = collectCompile(traces);
    expect(report.shape).toContain("offset");
    expect(report.shape).not.toContain("cursor");
    const letter = formatCompile(report);
    expect(letter).toMatch(/offset pages until the last page/);
    expect(letter).toMatch(/offset listIssues/);
    expect(letter).not.toMatch(/listIssues → listIssues → listIssues/);
    expect(letter).not.toMatch(/kind:\s*"loop"|until:/);
  });

  test("letter names poll until ready when traces compile to a poll", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => ({
      id: `pol${i}`,
      llmCalls: 4,
      duration_ms: 40,
      cost_cents: 4,
      complete: true,
      input: { ns: `n${i}` },
      events: [
        { name: "getRollout", args: { ns: `n${i}` }, result: { ready: false }, ok: true },
        { name: "getRollout", args: { ns: `n${i}` }, result: { ready: false }, ok: true },
        { name: "getRollout", args: { ns: `n${i}` }, result: { ready: true }, ok: true },
        { name: "cutOver", args: { ns: `n${i}` }, result: { cut: true }, ok: true },
      ],
    }));
    const report = collectCompile(traces);
    expect(report.shape).toContain("poll");
    const letter = formatCompile(report);
    expect(letter).toMatch(/poll until ready/);
    expect(letter).toMatch(/poll getRollout → cutOver/);
    expect(letter).not.toMatch(/getRollout → getRollout → getRollout/);
    expect(letter).not.toMatch(/kind:\s*"loop"|until:/);
  });

  test("letter names one or two next-command lines after the facts", () => {
    const repeating = formatCompile(collectCompile(repeatingTraces()));
    expect(repeating).toMatch(/lookupTicket_to_notify/);
    expect(repeating).toMatch(/lookupTicket → writeRecord → notify/);
    expect(repeating).toMatch(/turns-saved estimate/);
    expect(repeating).toMatch(/Refusals: none/);
    expect(repeating).toMatch(/eden approve/);
    expect(repeating).toMatch(/read the verdict; cannot ship FAIL \/ INCONCLUSIVE/);
    expect(repeating).not.toMatch(/eden play/);
    expect(repeating).not.toMatch(/Approve|certified/);
    const nextIdx = repeating.indexOf("Next:");
    expect(nextIdx).toBeGreaterThan(repeating.indexOf("Refusals:"));
    expect(
      repeating
        .slice(nextIdx)
        .split("\n")
        .filter((l) => l.trim().startsWith("eden ")).length,
    ).toBeLessThanOrEqual(2);

    const withSpec = formatCompile(collectCompile(repeatingTraces()), "examples/compile-traces/repeating");
    expect(withSpec).toMatch(/eden import --traces examples\/compile-traces\/repeating/);
    expect(withSpec).toMatch(/read the verdict; cannot ship FAIL \/ INCONCLUSIVE/);
    expect(withSpec).not.toMatch(/eden play/);
    const specCmds = withSpec
      .slice(withSpec.indexOf("Next:"))
      .split("\n")
      .filter((l) => l.trim().startsWith("eden "));
    expect(specCmds[0]).toMatch(/eden import --traces examples\/compile-traces\/repeating/);
    expect(specCmds[1]).toMatch(/eden approve$/);
    expect(specCmds).toHaveLength(2);

    const unique = formatCompile(collectCompile(uniqueWorkTraces()));
    expect(unique).toMatch(/0 programs/);
    expect(unique).toMatch(/Unique work/);
    expect(unique).toMatch(/not a compile win/);
    expect(unique).toMatch(/eden explain/);
    expect(unique).not.toMatch(/eden play/);
    expect(unique).not.toMatch(/certified|\blive\b/i);
    expect(formatCompile(collectCompile(uniqueWorkTraces()), "examples/compile-traces/unique")).not.toMatch(
      /eden import|eden play/,
    );

    const refuse = formatCompile(collectCompile(underdeterminedTraces()));
    expect(refuse).toMatch(/underdetermined_write/);
    expect(refuse).toMatch(/0 programs/);
    expect(refuse).toMatch(/eden explain/);
    expect(refuse).not.toMatch(/eden play/);
    expect(formatCompile(collectCompile(underdeterminedTraces()), "examples/compile-traces/refuse")).not.toMatch(
      /eden import|eden play/,
    );

    const json = formatCompileJson(collectCompile(repeatingTraces()));
    expect(json).not.toMatch(/Next:|eden play|eden approve|eden explain|eden import/);
    const body = JSON.parse(json) as Record<string, unknown>;
    expect(body).not.toHaveProperty("next");
    expect(body.programs).toBeDefined();
    expect(body.refusals).toBeDefined();
    expect(typeof body.turnsSaved).toBe("number");
    expect(typeof body.uniqueWork).toBe("boolean");
  });

  test("published CLI package is @kaiavn/eden with no workspace deps", async () => {
    const pkg = (await Bun.file(join(import.meta.dir, "../package.json")).json()) as {
      name: string;
      bin?: { eden?: string };
      files?: string[];
      dependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe("@kaiavn/eden");
    expect(pkg.bin?.eden).toBe("./dist/eden.js");
    expect(pkg.files).toContain("dist/eden.js");
    expect(pkg.files).toContain("dist/demo.js");
    expect(pkg.dependencies).toBeUndefined();
  });

  test("shipped dist binary includes compile --traces (must not go stale)", async () => {
    const dist = join(import.meta.dir, "../dist/eden.js");
    if (!existsSync(dist)) return;
    const proc = Bun.spawn(["bun", dist, "compile", "--help"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(text).toMatch(/--traces/);
    expect(text).toMatch(/Does not Approve/);
    expect(text).not.toMatch(/Quick start:/);
    const letter = Bun.spawn(
      ["bun", dist, "compile", "--traces", join(import.meta.dir, "../../../examples/compile-traces/repeating")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(letter.stdout).text();
    expect(await letter.exited).toBe(0);
    expect(out).toMatch(/lookupTicket → writeRecord → notify/);
    const root = Bun.spawn(["bun", dist], { stdout: "pipe", stderr: "pipe" });
    const help = await new Response(root.stdout).text();
    expect(await root.exited).toBe(0);
    expect(help).toMatch(/help -a/);
    expect(help).not.toMatch(/^\s+audit export/m);
    const nope = Bun.spawn(["bun", dist, "nope"], { stdout: "pipe", stderr: "pipe" });
    const nopeErr = await new Response(nope.stderr).text();
    expect(await nope.exited).toBe(1);
    expect(nopeErr.trim()).toBe("eden: 'nope' is not an eden command. See 'eden --help'.");
  });
});
