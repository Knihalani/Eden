/**
 * Third horizon tranche: TLS host, CDN path, LDAP email. CompileTraces +
 * goLive. FAIL not skip-as-win.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  GROUP_DNS,
  SITE_IDS,
  ZONE_IDS,
  certsFor,
  createCdnPurge,
  createCertRenew,
  createLdapMail,
  membersFor,
  routesFor,
} from "./horizon-more-worlds";

process.env.CAMPAIGN_THINK_MS = "0";
const TIMEOUT = 8_000;

async function recordStretch(world: World, goal: Record<string, unknown>, seed: number): Promise<StretchTrace> {
  const tools = world.tools();
  const gen = world.script(goal, mulberry32(seed >>> 0));
  const events: StretchTrace["events"] = [];
  let sent: CallResult | undefined;
  let lastValue: unknown;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    const { tool, args } = next.value;
    const t0 = performance.now();
    let out: CallResult;
    try {
      const v = await tools[tool]!.execute(args);
      out = { ok: true, value: v };
      lastValue = v;
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    events.push({
      name: tool,
      args,
      result: out.ok ? out.value : { error: out.error },
      ok: out.ok,
      duration_ms: performance.now() - t0,
    });
    sent = out;
    if (out.ok && world.done(out.value)) break;
  }
  return {
    id: `${world.name}-${seed}`,
    events,
    input: goal,
    output: lastValue,
    llmCalls: events.length,
    duration_ms: Math.max(1, Math.round(events.reduce((a, e) => a + (e.duration_ms ?? 0), 0))),
    cost_cents: events.length,
    skipped: [],
    complete: true,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) traces.push(await recordStretch(factory(), goals[i % goals.length]!, 300 + i));
  return traces;
}

function loopOverFrom(p: { steps: Array<{ kind: string; over?: { kind: string; step?: string; path?: string } }> }, tool: string) {
  const loop = p.steps.find((s) => s.kind === "loop");
  expect(loop && loop.kind === "loop").toBe(true);
  const over = loop && "over" in loop ? loop.over : undefined;
  expect(over && over.kind === "from" && over.step === tool).toBe(true);
  return over;
}

describe("horizon more: compileTraces", () => {
  test(
    "cert-renew: foreach over certs binds host from the item",
    async () => {
      const traces = await recordN(
        createCertRenew,
        [...SITE_IDS].map((site) => ({ site })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
      expect(p, `cert-renew ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const over = loopOverFrom(p!, "listExpiring");
      expect(over && "path" in over ? over.path : undefined).toBe("certs");
      const renew = p!.steps.find((s) => s.kind === "tool" && s.tool === "renewCert");
      expect(renew && renew.kind === "tool" ? renew.args.host : undefined).toMatchObject({ kind: "from", path: "host" });
      expect(certsFor(SITE_IDS[0]).map((c) => c.host)).toHaveLength(3);
    },
    TIMEOUT,
  );

  test(
    "cdn-purge: foreach over routes binds path from the item",
    async () => {
      const traces = await recordN(
        createCdnPurge,
        [...ZONE_IDS].map((zone) => ({ zone })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
      expect(p, `cdn-purge ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const over = loopOverFrom(p!, "listRoutes");
      expect(over && "path" in over ? over.path : undefined).toBe("routes");
      const purge = p!.steps.find((s) => s.kind === "tool" && s.tool === "purgePath");
      expect(purge && purge.kind === "tool" ? purge.args.path : undefined).toMatchObject({ kind: "from", path: "path" });
      expect(routesFor(ZONE_IDS[0])).toHaveLength(3);
    },
    TIMEOUT,
  );

  test(
    "ldap-mail: foreach over members binds email from the item",
    async () => {
      const traces = await recordN(
        createLdapMail,
        [...GROUP_DNS].map((dn) => ({ dn })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
      expect(p, `ldap-mail ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const over = loopOverFrom(p!, "listMembers");
      expect(over && "path" in over ? over.path : undefined).toBe("members");
      const mail = p!.steps.find((s) => s.kind === "tool" && s.tool === "mailMember");
      expect(mail && mail.kind === "tool" ? mail.args.email : undefined).toMatchObject({
        kind: "from",
        path: "email",
      });
      expect(membersFor(GROUP_DNS[0]).map((m) => m.email)).toHaveLength(3);
    },
    TIMEOUT,
  );
});

describe("horizon more: goLive", () => {
  test(
    "cert / cdn / ldap goLive PASS; wrap serve turns===1",
    async () => {
      const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>> }> = [
        { name: "cert-renew", factory: createCertRenew, goals: [...SITE_IDS].map((site) => ({ site })) },
        { name: "cdn-purge", factory: createCdnPurge, goals: [...ZONE_IDS].map((zone) => ({ zone })) },
        { name: "ldap-mail", factory: createLdapMail, goals: [...GROUP_DNS].map((dn) => ({ dn })) },
      ];
      for (const c of cases) {
        const s = new Session([[c.name, c.factory]], true);
        for (let i = 0; i < 13; i++) {
          await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`more-live-${c.name}-${i}`, i));
        }
        const r = await s.goLive(c.name, { compile: 9, holdout: 3, sandbox: c.factory, maxGram: 26 });
        expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
        expect(r.program).not.toBeNull();
        const live = new Session([[c.name, c.factory]], true);
        live.addPrograms([r.program!]);
        await live.stretch(c.name, c.goals[0]!, blockSeed(`more-serve-${c.name}`, 99));
        const fin = live.finish();
        expect(fin.violations, `${c.name} ${fin.violations.join("; ")}`).toEqual([]);
        expect(fin.turns, `${c.name} turns=${fin.turns}`).toBe(1);
      }
    },
    90_000,
  );
});
