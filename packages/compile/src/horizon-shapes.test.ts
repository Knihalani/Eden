import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { compileTraces } from "./index";
import { registryFrom, runProgram } from "@eden/runtime";

function trace(
  id: string,
  events: StretchTrace["events"],
  input: Record<string, unknown>,
): StretchTrace {
  return {
    id,
    events,
    input,
    output: { ok: true },
    llmCalls: 6,
    duration_ms: 40,
    cost_cents: 4,
    complete: true,
  };
}

describe("horizon shapes", () => {
  test("A: grep-12/read-6 with sibling leftover `more` refuses read_set_mismatch, not slice/except", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const hits = Array.from({ length: 12 }, (_, j) => `src/m${j}/impl.ts`);
      const read = [1, 3, 5, 7, 9, 11].map((j) => hits[j]!);
      const more = hits.filter((_, j) => j % 2 === 0);
      return trace(
        `rs-${i}`,
        [
          { name: "grepCode", args: { pattern: `p${i}` }, result: { hits, more }, ok: true },
          ...read.map((path) => ({ name: "readFile", args: { path }, result: { path, lines: ["ok"] }, ok: true })),
          { name: "writeNotes", args: { topic: `p${i}` }, result: { notesWritten: true }, ok: true },
        ],
        { topic: `p${i}` },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(programs.filter((p) => p.steps.some((s) => s.kind === "loop"))).toHaveLength(0);
    const hit = refusals.find((r) => r.code === "read_set_mismatch" && r.readSet === 12 && r.repeats === 6);
    expect(hit).toBeDefined();
    for (const p of programs) {
      for (const s of p.steps) {
        if (s.kind !== "loop") continue;
        expect(s.over.kind === "transform" && s.over.fn === "slice").toBe(false);
        expect(s.over.kind === "transform" && s.over.fn === "except").toBe(false);
      }
    }
  });

  test("B: nested foreach binds restartPod.ns from outer item and name from inner item", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const orgs = [{ name: `ns-${i}-a` }, { name: `ns-${i}-b` }];
      return trace(
        `nest-${i}`,
        [
          { name: "listOrgs", args: { q: `open-${i}` }, result: { orgs }, ok: true },
          ...orgs.flatMap((org) => {
            const pods = [
              { name: `${org.name}-p0`, node: "n0" },
              { name: `${org.name}-p1`, node: "n1" },
            ];
            return [
              { name: "listPods", args: { ns: org.name }, result: { pods }, ok: true },
              ...pods.map((pod) => ({
                name: "restartPod",
                args: { ns: org.name, name: pod.name },
                result: { restarted: true, ns: org.name, name: pod.name },
                ok: true,
              })),
            ];
          }),
          { name: "verifyCluster", args: { q: `open-${i}` }, result: { verified: true }, ok: true },
        ],
        { q: `open-${i}` },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach" || r.code === "read_set_mismatch")).toEqual([]);
    const p = programs.find((q) =>
      q.steps.some((s) => s.kind === "loop" && s.body.some((id) => q.steps.some((x) => x.id === id && x.kind === "loop"))),
    );
    expect(p).toBeDefined();
    const inner = p!.steps.find((s) => s.kind === "loop" && s.id.includes("inner"));
    expect(inner && inner.kind === "loop").toBe(true);
    const bodyId = inner && inner.kind === "loop" ? inner.body[0] : undefined;
    const restart = p!.steps.find((s) => s.id === bodyId && s.kind === "tool");
    expect(restart && restart.kind === "tool" && restart.tool === "restartPod").toBe(true);
    const outer = p!.steps.find(
      (s) => s.kind === "loop" && inner && s.body.includes(inner.id),
    );
    expect(outer && outer.kind === "loop").toBe(true);
    const ns = restart && restart.kind === "tool" ? restart.args.ns : undefined;
    const name = restart && restart.kind === "tool" ? restart.args.name : undefined;
    expect(ns).toEqual({ kind: "from", step: (outer as { item: string }).item, path: "name" });
    expect(name).toEqual({ kind: "from", step: (inner as { item: string }).item, path: "name" });

    const pairs: Array<{ ns: string; name: string }> = [];
    const orgs = [{ name: "ns-0-a" }, { name: "ns-0-b" }];
    const podsOf = (ns: string) => [
      { name: `${ns}-p0`, node: "n0" },
      { name: `${ns}-p1`, node: "n1" },
    ];
    const reg = registryFrom({
      listOrgs: async () => ({ orgs }),
      listPods: async ({ ns }) => ({ pods: podsOf(String(ns)) }),
      restartPod: async ({ ns, name }) => {
        pairs.push({ ns: String(ns), name: String(name) });
        return { restarted: true };
      },
      verifyCluster: async () => ({ verified: true }),
    });
    await runProgram(p!, { q: "open-0" }, { registry: reg });
    expect(pairs).toEqual([
      { ns: "ns-0-a", name: "ns-0-a-p0" },
      { ns: "ns-0-a", name: "ns-0-a-p1" },
      { ns: "ns-0-b", name: "ns-0-b-p0" },
      { ns: "ns-0-b", name: "ns-0-b-p1" },
    ]);
  });

  test("C: three witnessed arms compile to one n-way branch with cases", async () => {
    const traces: StretchTrace[] = [];
    const arms: Array<{ sev: string; tools: [string, string]; ids: number[] }> = [
      { sev: "p0", tools: ["createPage", "sendAckPage"], ids: [10, 11, 12] },
      { sev: "p1", tools: ["createTicket", "sendAckTicket"], ids: [20, 21, 22] },
      { sev: "p2", tools: ["writeLog", "sendAckLog"], ids: [30, 31, 32] },
    ];
    for (const arm of arms) {
      for (const [i, id] of arm.ids.entries()) {
        const alert = `al-${id}`;
        traces.push(
          trace(
            `${arm.sev}-${i}`,
            [
              { name: "getAlert", args: { id }, result: { sev: arm.sev, alert }, ok: true },
              { name: arm.tools[0], args: { alert }, result: { acked: true, alert }, ok: true },
              { name: arm.tools[1], args: { alert }, result: { done: true, alert }, ok: true },
            ],
            { id },
          ),
        );
      }
    }
    const { programs } = compileTraces(traces);
    const p = programs.find((q) => q.steps.filter((s) => s.kind === "branch").length === 1);
    expect(p).toBeDefined();
    expect(programs.filter((q) => q.steps.some((s) => s.kind === "branch"))).toHaveLength(1);
    const br = p!.steps.find((s) => s.kind === "branch");
    expect(br && br.kind === "branch" && (br.cases?.length ?? 0)).toBe(1);
    for (const arm of arms) {
      const calls: string[] = [];
      const tools: Record<string, (a: Record<string, unknown>) => unknown> = {
        getAlert: ({ id }) => ({ sev: arm.sev, alert: `al-${id}` }),
      };
      for (const t of arm.tools) {
        tools[t] = () => {
          calls.push(t);
          return { done: true };
        };
      }
      await runProgram(p!, { id: arm.ids[0] }, { registry: registryFrom(tools) });
      expect(calls).toEqual([...arm.tools]);
    }
  });

  test("D: set-difference foreach emits except over two prior tools and creates only A\\B", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const desired = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const current = [{ id: "a" }];
      const missing = [{ id: "b" }, { id: "c" }];
      const batch = `W${i}`;
      return trace(
        `delta-${i}`,
        [
          { name: "listDesired", args: { batch }, result: { items: desired }, ok: true },
          { name: "listCurrent", args: { batch }, result: { items: current }, ok: true },
          ...missing.map((it) => ({
            name: "createMissing",
            args: { id: it.id },
            result: { created: true, id: it.id },
            ok: true,
          })),
          { name: "publishWave", args: { batch }, result: { published: true }, ok: true },
        ],
        { batch },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach" || r.code === "read_set_mismatch")).toEqual([]);
    const p = programs.find((q) =>
      q.steps.some((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "except"),
    );
    expect(p).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop")!;
    expect(loop.kind).toBe("loop");
    const over = loop.kind === "loop" ? loop.over : null;
    expect(over && over.kind === "transform" && over.fn === "except").toBe(true);
    const created: string[] = [];
    const reg = registryFrom({
      listDesired: async () => ({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      listCurrent: async () => ({ items: [{ id: "a" }] }),
      createMissing: async ({ id }) => {
        created.push(String(id));
        return { created: true, id };
      },
      publishWave: async () => ({ published: true }),
    });
    await runProgram(p!, { batch: "W0" }, { registry: reg });
    expect(created).toEqual(["b", "c"]);
  });

  test("github path/sha and inventory sku/qty/warehouse still bind from the item", () => {
    const gh: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const files = [
        { path: `src/a${i}.ts`, sha: `sha-a${i}` },
        { path: `src/b${i}.ts`, sha: `sha-b${i}` },
      ];
      return trace(
        `gh-${i}`,
        [
          { name: "listFiles", args: { repo: `r${i}` }, result: { files }, ok: true },
          ...files.map((f) => ({
            name: "getBlob",
            args: { path: f.path, sha: f.sha },
            result: { path: f.path, sha: f.sha },
            ok: true,
          })),
          { name: "notify", args: { repo: `r${i}` }, result: { ok: true }, ok: true },
        ],
        { repo: `r${i}` },
      );
    });
    const { programs } = compileTraces(gh);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop")!;
    const body = p!.steps.find((s) => s.kind === "tool" && s.tool === "getBlob");
    expect(body && body.kind === "tool").toBe(true);
    if (loop.kind === "loop" && body && body.kind === "tool") {
      expect(body.args.path).toEqual({ kind: "from", step: loop.item, path: "path" });
      expect(body.args.sha).toEqual({ kind: "from", step: loop.item, path: "sha" });
    }

    const inv: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const items = [
        { sku: `a${i}`, qty: 2, warehouse: "w1" },
        { sku: `b${i}`, qty: 4, warehouse: "w2" },
      ];
      return trace(
        `inv-${i}`,
        [
          { name: "listStock", args: { cart: `C${i}` }, result: { items }, ok: true },
          ...items.map((it) => ({
            name: "reserveSku",
            args: { sku: it.sku, qty: it.qty, warehouse: it.warehouse },
            result: { reserved: true, sku: it.sku },
            ok: true,
          })),
          { name: "checkoutCart", args: { cart: `C${i}` }, result: { paid: true }, ok: true },
        ],
        { cart: `C${i}` },
      );
    });
    const inved = compileTraces(inv);
    const ip = inved.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(ip).toBeDefined();
    const iloop = ip!.steps.find((s) => s.kind === "loop")!;
    const reserve = ip!.steps.find((s) => s.kind === "tool" && s.tool === "reserveSku");
    expect(reserve && reserve.kind === "tool").toBe(true);
    if (iloop.kind === "loop" && reserve && reserve.kind === "tool") {
      expect(reserve.args.sku).toEqual({ kind: "from", step: iloop.item, path: "sku" });
      expect(reserve.args.qty).toEqual({ kind: "from", step: iloop.item, path: "qty" });
      expect(reserve.args.warehouse).toEqual({ kind: "from", step: iloop.item, path: "warehouse" });
    }
  });

  test("flags cohort+pct two-field items bind both args from the item, not unbound_foreach", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const flag = `feat-${i}`;
      const cohorts = [
        { cohort: `${flag}-beta`, pct: 5 },
        { cohort: `${flag}-ga`, pct: 100 },
      ];
      return trace(
        `flag-${i}`,
        [
          { name: "getFlag", args: { flag }, result: { flag, enabled: true }, ok: true },
          { name: "listCohorts", args: { flag }, result: { cohorts, flag }, ok: true },
          ...cohorts.map((c) => ({
            name: "setRollout",
            args: { cohort: c.cohort, pct: c.pct, flag },
            result: { set: true, cohort: c.cohort, pct: c.pct },
            ok: true,
          })),
          { name: "publishFlag", args: { flag }, result: { published: true, flag }, ok: true },
        ],
        { flag },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach" || r.code === "read_set_mismatch")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop")!;
    const set = p!.steps.find((s) => s.kind === "tool" && s.tool === "setRollout");
    expect(loop.kind === "loop" && set && set.kind === "tool").toBe(true);
    if (loop.kind === "loop" && set && set.kind === "tool") {
      expect(set.args.cohort).toEqual({ kind: "from", step: loop.item, path: "cohort" });
      expect(set.args.pct).toEqual({ kind: "from", step: loop.item, path: "pct" });
    }
  });

  test("E: four-level nested JSON binds chargeCard.token from org.billing.card.token", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const account = `ac-${i}`;
      const token = `tok_${i}_deep`;
      return trace(
        `deep-${i}`,
        [
          {
            name: "getAccount",
            args: { account },
            result: { org: { billing: { card: { last4: "4242", token } } } },
            ok: true,
          },
          { name: "chargeCard", args: { token }, result: { authorized: true, token }, ok: true },
          { name: "chargeCapture", args: { token }, result: { captured: true, token }, ok: true },
          { name: "sendReceipt", args: { account }, result: { emailed: true, account }, ok: true },
        ],
        { account },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "underdetermined_write")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "tool" && s.tool === "chargeCard"));
    expect(p).toBeDefined();
    const charge = p!.steps.find((s) => s.kind === "tool" && s.tool === "chargeCard");
    expect(charge && charge.kind === "tool" ? charge.args.token : undefined).toEqual({
      kind: "from",
      step: "getAccount",
      path: "org.billing.card.token",
    });
    const tokens: string[] = [];
    const reg = registryFrom({
      getAccount: async () => ({ org: { billing: { card: { last4: "4242", token: "tok_0_deep" } } } }),
      chargeCard: async ({ token }) => {
        tokens.push(String(token));
        return { authorized: true };
      },
      chargeCapture: async () => ({ captured: true }),
      sendReceipt: async () => ({ emailed: true }),
    });
    await runProgram(p!, { account: "ac-0" }, { registry: reg });
    expect(tokens).toEqual(["tok_0_deep"]);
  });

  test("F: Relay edges bind updateIssue from node.id / node.title, not a top-level edge id", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const edges = [0, 1, 2].map((j) => ({
        node: { id: `ISSUE-${i}-${j}`, title: `t-${i}-${j}`, number: j + 1 },
      }));
      return trace(
        `gql-${i}`,
        [
          { name: "listIssues", args: { repo: `r-${i}` }, result: { edges }, ok: true },
          ...edges.map((e) => ({
            name: "updateIssue",
            args: { id: e.node.id, title: e.node.title },
            result: { id: e.node.id, updated: true },
            ok: true,
          })),
          { name: "publishDigest", args: { repo: `r-${i}` }, result: { published: true }, ok: true },
        ],
        { repo: `r-${i}` },
      );
    });
    const { programs } = compileTraces(traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop" && loop.over).toMatchObject({ path: "edges" });
    const body = p!.steps.find((s) => s.kind === "tool" && s.tool === "updateIssue");
    expect(body && body.kind === "tool").toBe(true);
    if (body && body.kind === "tool") {
      expect(String(body.args.id && "path" in body.args.id ? body.args.id.path : "")).toMatch(/node\.id/);
      expect(String(body.args.title && "path" in body.args.title ? body.args.title.path : "")).toMatch(/node\.title/);
    }
  });

  test("nested data.edges Relay loop binds node.id from item, compiles, executes", async () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const edges = [0, 1].map((j) => ({
        node: { id: `ISSUE-${i}-${j}`, title: `t-${i}-${j}`, number: j + 1 },
      }));
      return trace(
        `gql-data-${i}`,
        [
          { name: "listIssues", args: { repo: `r-${i}` }, result: { data: { edges } }, ok: true },
          ...edges.map((e) => ({
            name: "updateIssue",
            args: { id: e.node.id, title: e.node.title },
            result: { id: e.node.id, updated: true },
            ok: true,
          })),
          { name: "publishDigest", args: { repo: `r-${i}` }, result: { published: true }, ok: true },
        ],
        { repo: `r-${i}` },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach" || r.code === "read_set_mismatch")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p).toBeDefined();
    const loop = p!.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop" && loop.over).toMatchObject({ kind: "from", path: "data.edges" });
    const body = p!.steps.find((s) => s.kind === "tool" && s.tool === "updateIssue");
    expect(body && body.kind === "tool").toBe(true);
    if (loop && loop.kind === "loop" && body && body.kind === "tool") {
      expect(body.args.id).toEqual({ kind: "from", step: loop.item, path: "node.id" });
      expect(body.args.title).toEqual({ kind: "from", step: loop.item, path: "node.title" });
    }

    const ids: string[] = [];
    const edges = [0, 1].map((j) => ({ node: { id: `ISSUE-0-${j}`, title: `t-0-${j}`, number: j + 1 } }));
    const reg = registryFrom({
      listIssues: async () => ({ data: { edges } }),
      updateIssue: async ({ id }) => {
        ids.push(String(id));
        return { updated: true };
      },
      publishDigest: async () => ({ published: true }),
    });
    await runProgram(p!, { repo: "r-0" }, { registry: reg });
    expect(ids).toEqual(["ISSUE-0-0", "ISSUE-0-1"]);
  });

  test("two nested arrays that both match the walked items fail closed", () => {
    const traces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const edges = [0, 1].map((j) => ({ node: { id: `E-${i}-${j}` } }));
      const also = edges.map((e) => ({ ...e }));
      return trace(
        `amb-${i}`,
        [
          { name: "listIssues", args: { repo: `r-${i}` }, result: { data: { edges }, also: { edges: also } }, ok: true },
          ...edges.map((e) => ({
            name: "updateIssue",
            args: { id: e.node.id },
            result: { id: e.node.id, updated: true },
            ok: true,
          })),
          { name: "publishDigest", args: { repo: `r-${i}` }, result: { published: true }, ok: true },
        ],
        { repo: `r-${i}` },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(programs.filter((p) => p.steps.some((s) => s.kind === "loop"))).toHaveLength(0);
    expect(refusals.some((r) => r.code === "unbound_foreach" || r.code === "read_set_mismatch")).toBe(true);
  });

  test("G: SSO createUser.body binds as an object assembled from input, not a string", async () => {
    const traces: StretchTrace[] = Array.from({ length: 4 }, (_, i) => {
      const orgId = `org-${i}`;
      const email = `u${i}@co.com`;
      const body = { user: { email, name: `User ${email}` }, orgId };
      return trace(
        `sso-${i}`,
        [
          { name: "getOrg", args: { orgId, email }, result: { orgId, plan: "pro" }, ok: true },
          { name: "createUser", args: { body }, result: { created: true, orgId, email }, ok: true },
          { name: "grantRole", args: { email, role: "member" }, result: { granted: true }, ok: true },
          { name: "sendInvite", args: { email }, result: { invited: true }, ok: true },
        ],
        { orgId, email },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "underdetermined_write")).toEqual([]);
    const p = programs.find((q) => q.sequence.length >= 4);
    expect(p).toBeDefined();
    expect(Object.keys(p!.contract.envelope?.inputs ?? {}).sort()).toEqual(["email", "orgId"]);
    const create = p!.steps.find((s) => s.kind === "tool" && s.tool === "createUser");
    expect(create && create.kind === "tool").toBe(true);
    const body = create && create.kind === "tool" ? create.args.body : undefined;
    expect(body, "body must be bound").toBeDefined();
    expect(body?.kind === "from" || body?.kind === "transform" || body?.kind === "input").toBe(true);
    if (body?.kind === "transform") {
      expect(body.fn).toBe("template");
      expect(body.expr.trim().startsWith("{")).toBe(true);
    }
    const seen: unknown[] = [];
    const reg = registryFrom({
      getOrg: async ({ orgId }) => ({ orgId, plan: "pro" }),
      createUser: async ({ body: b }) => {
        seen.push(b);
        return { created: true };
      },
      grantRole: async () => ({ granted: true }),
      sendInvite: async () => ({ invited: true }),
    });
    await runProgram(p!, { orgId: "org-0", email: "u0@co.com" }, { registry: reg });
    expect(seen).toEqual([{ user: { email: "u0@co.com", name: "User u0@co.com" }, orgId: "org-0" }]);
  });

  test("mixed JSON: createUser.body uses email from input and orgId from getOrg.result", async () => {
    const traces: StretchTrace[] = Array.from({ length: 4 }, (_, i) => {
      const email = `u${i}@co.com`;
      const orgId = `org-${i}`;
      const body = { user: { email, name: `User ${email}` }, orgId };
      return trace(
        `mix-${i}`,
        [
          { name: "getOrg", args: { email }, result: { orgId, plan: "pro" }, ok: true },
          { name: "createUser", args: { body }, result: { created: true, orgId, email }, ok: true },
          { name: "grantRole", args: { email, role: "member" }, result: { granted: true }, ok: true },
          { name: "sendInvite", args: { email }, result: { invited: true }, ok: true },
        ],
        { email },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "underdetermined_write")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "tool" && s.tool === "createUser"));
    expect(p).toBeDefined();
    const create = p!.steps.find((s) => s.kind === "tool" && s.tool === "createUser");
    expect(create && create.kind === "tool").toBe(true);
    const body = create && create.kind === "tool" ? create.args.body : undefined;
    expect(body, "body must be bound").toBeDefined();
    expect(body?.kind).toBe("transform");
    if (body?.kind === "transform") {
      expect(body.fn).toBe("template");
      expect(body.expr.trim().startsWith("{")).toBe(true);
      expect(body.expr).toContain("{email}");
      expect(body.expr).toContain("{orgId}");
      expect(typeof (body as { value?: unknown }).value).not.toBe("string");
      expect(body.of.kind).toBe("from");
      if (body.of.kind === "from") expect(body.of.step).toBe("getOrg");
    }

    const seen: unknown[] = [];
    const reg = registryFrom({
      getOrg: async () => ({ orgId: "org-live", plan: "pro" }),
      createUser: async ({ body: b }) => {
        seen.push(b);
        return { created: true };
      },
      grantRole: async () => ({ granted: true }),
      sendInvite: async () => ({ invited: true }),
    });
    await runProgram(p!, { email: "u0@co.com" }, { registry: reg });
    expect(seen).toEqual([{ user: { email: "u0@co.com", name: "User u0@co.com" }, orgId: "org-live" }]);
  });

  test("quoted double-quote inside a JSON slot fails closed, not a guessed template", () => {
    const traces: StretchTrace[] = Array.from({ length: 4 }, (_, i) => {
      const email = `u${i}"x@co.com`;
      const orgId = `org-${i}`;
      const body = { user: { email }, orgId };
      return trace(
        `qslot-${i}`,
        [
          { name: "getOrg", args: { orgId, email }, result: { orgId, plan: "pro" }, ok: true },
          { name: "createUser", args: { body }, result: { created: true }, ok: true },
          { name: "grantRole", args: { email, role: "member" }, result: { granted: true }, ok: true },
          { name: "sendInvite", args: { email }, result: { invited: true }, ok: true },
        ],
        { orgId, email },
      );
    });
    const { programs, refusals } = compileTraces(traces);
    const create = programs
      .flatMap((q) => q.steps)
      .find((s) => s.kind === "tool" && s.tool === "createUser");
    const body = create && create.kind === "tool" ? create.args.body : undefined;
    expect(body?.kind === "transform" && body.fn === "template").toBe(false);
    expect(refusals.some((r) => r.code === "underdetermined_write") || !create).toBe(true);
  });

  test("H: quoted SQL report id interpolates, not a literal", async () => {
    const traces: StretchTrace[] = Array.from({ length: 4 }, (_, i) => {
      const report = `R-${i + 1}`;
      const sql = `SELECT * FROM events WHERE report = '${report}'`;
      return trace(
        `sql-${i}`,
        [
          { name: "runQuery", args: { sql, report }, result: { sql, n: 8 }, ok: true },
          { name: "fetchRows", args: { report }, result: { report, rows: 8 }, ok: true },
          { name: "writeCsv", args: { report }, result: { wrote: true }, ok: true },
          { name: "mailReport", args: { report }, result: { mailed: true }, ok: true },
        ],
        { report },
      );
    });
    const { programs } = compileTraces(traces);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "tool" && s.tool === "runQuery"));
    expect(p).toBeDefined();
    const run = p!.steps.find((s) => s.kind === "tool" && s.tool === "runQuery");
    expect(run && run.kind === "tool").toBe(true);
    const sql = run && run.kind === "tool" ? run.args.sql : undefined;
    expect(sql?.kind).toBe("transform");
    if (sql?.kind === "transform") {
      expect(sql.fn).toBe("template");
      expect(sql.expr).toContain("{report}");
      expect(sql.expr).not.toContain("R-1");
    }
    const seen: string[] = [];
    const reg = registryFrom({
      runQuery: async ({ sql: q }) => {
        seen.push(String(q));
        return { n: 8 };
      },
      fetchRows: async () => ({ rows: 8 }),
      writeCsv: async () => ({ wrote: true }),
      mailReport: async () => ({ mailed: true }),
    });
    await runProgram(p!, { report: "R-1" }, { registry: reg });
    await runProgram(p!, { report: "R-2" }, { registry: reg });
    expect(seen[0]).toBe("SELECT * FROM events WHERE report = 'R-1'");
    expect(seen[1]).toBe("SELECT * FROM events WHERE report = 'R-2'");
    expect(seen[0]).not.toEqual(seen[1]);
  });

  test("I: ranked prefix top-k slices; unranked string prefix still refuses", () => {
    const ranked: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const hits = Array.from({ length: 10 }, (_, j) => ({
        id: `h${i}-${j}`,
        score: 100 - j * 7,
        rank: j + 1,
      }));
      const top = hits.slice(0, 3);
      return trace(
        `rk-${i}`,
        [
          { name: "searchHits", args: { q: `q${i}` }, result: { hits }, ok: true },
          ...top.map((h) => ({ name: "takeHit", args: { id: h.id }, result: { id: h.id, took: true }, ok: true })),
          { name: "writeDigest", args: { q: `q${i}` }, result: { wrote: true }, ok: true },
        ],
        { q: `q${i}` },
      );
    });
    const sliced = compileTraces(ranked);
    const rp = sliced.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(rp).toBeDefined();
    const rloop = rp!.steps.find((s) => s.kind === "loop");
    expect(rloop && rloop.kind === "loop" && rloop.over.kind === "transform" && rloop.over.fn === "slice").toBe(true);

    const strings: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
      const hits = Array.from({ length: 12 }, (_, j) => `src/m${j}/impl.ts`);
      const read = hits.slice(0, 6);
      return trace(
        `str-${i}`,
        [
          { name: "grepCode", args: { pattern: `p${i}` }, result: { hits }, ok: true },
          ...read.map((path) => ({ name: "readFile", args: { path }, result: { path, lines: ["ok"] }, ok: true })),
          { name: "writeNotes", args: { topic: `p${i}` }, result: { notesWritten: true }, ok: true },
        ],
        { topic: `p${i}` },
      );
    });
    const refused = compileTraces(strings);
    expect(refused.programs.filter((p) => p.steps.some((s) => s.kind === "loop"))).toHaveLength(0);
    expect(refused.refusals.find((r) => r.code === "read_set_mismatch" && r.readSet === 12 && r.repeats === 6)).toBeDefined();
  });
});
