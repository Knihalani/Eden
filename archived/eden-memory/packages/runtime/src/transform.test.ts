import { describe, expect, test } from "bun:test";
import { registryFrom, runProgram } from "../src/index";

describe("runtime transforms", () => {
  test("template interpolates from prior output", async () => {
    const registry = registryFrom({
      echo: ({ msg }) => ({ msg }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "e", kind: "tool", tool: "echo", args: { msg: { kind: "literal", value: "Acme" } } }],
        returns: {
          kind: "transform",
          fn: "template",
          expr: "Hi {msg}",
          of: { kind: "from", step: "e", path: "" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toBe("Hi Acme");
  });

  test("jsonpath transform", async () => {
    const registry = registryFrom({
      echo: () => ({ a: { b: 3 } }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "e", kind: "tool", tool: "echo", args: {} }],
        returns: { kind: "transform", fn: "jsonpath", expr: "a.b", of: { kind: "from", step: "e", path: "" } },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toBe(3);
  });

  test("except transform drops items whose id is in the exclusion array", async () => {
    const registry = registryFrom({
      desired: () => ({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      current: () => ({ items: [{ id: "a", extra: true }] }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          { id: "desired", kind: "tool", tool: "desired", args: {} },
          { id: "current", kind: "tool", tool: "current", args: {} },
        ],
        returns: {
          kind: "transform",
          fn: "except",
          expr: "current.items",
          of: { kind: "from", step: "desired", path: "items" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual([{ id: "b" }, { id: "c" }]);
  });

  test("except with empty path uses the whole prior result as the exclusion array", async () => {
    const registry = registryFrom({
      desired: () => ["a", "b", "c"],
      current: () => ["a"],
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          { id: "desired", kind: "tool", tool: "desired", args: {} },
          { id: "current", kind: "tool", tool: "current", args: {} },
        ],
        returns: {
          kind: "transform",
          fn: "except",
          expr: "current",
          of: { kind: "from", step: "desired", path: "" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual(["b", "c"]);
  });

  test("slice transform takes a prefix of an array", async () => {
    const registry = registryFrom({
      echo: () => ({ hits: [1, 2, 3, 4, 5] }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "e", kind: "tool", tool: "echo", args: {} }],
        returns: {
          kind: "transform",
          fn: "slice",
          expr: "0:3",
          of: { kind: "from", step: "e", path: "hits" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual([1, 2, 3]);
  });

  test("template JSON body parses to an object, not a string", async () => {
    const registry = registryFrom({
      echo: () => ({ email: "a@x.com", orgId: "o1" }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "e", kind: "tool", tool: "echo", args: {} }],
        returns: {
          kind: "transform",
          fn: "template",
          expr: '{"orgId":"{orgId}","user":{"email":"{email}"}}',
          of: { kind: "from", step: "e", path: "" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual({ orgId: "o1", user: { email: "a@x.com" } });
    expect(typeof result.value).toBe("object");
  });

  test("template JSON fills input slots that the prior result does not echo", async () => {
    const registry = registryFrom({
      getOrg: () => ({ orgId: "org-live", plan: "pro" }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "g", kind: "tool", tool: "getOrg", args: {} }],
        returns: {
          kind: "transform",
          fn: "template",
          expr: '{"orgId":"{orgId}","user":{"email":"{email}"}}',
          of: { kind: "from", step: "g", path: "" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      { email: "u0@co.com" },
      { registry },
    );
    expect(result.value).toEqual({ orgId: "org-live", user: { email: "u0@co.com" } });
  });

  test("template JSON parse failure throws rather than returning a string", async () => {
    const registry = registryFrom({
      echo: () => ({ email: 'a"x' }),
    });
    await expect(
      runProgram(
        {
          id: "p",
          version: "v",
          name: "p",
          description: "p",
          inputSchema: { type: "object" },
          steps: [{ id: "e", kind: "tool", tool: "echo", args: {} }],
          returns: {
            kind: "transform",
            fn: "template",
            expr: '{"email":"{email}"}',
            of: { kind: "from", step: "e", path: "" },
          },
          contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
          manifest: null,
        },
        {},
        { registry },
      ),
    ).rejects.toThrow(/template JSON parse failed/);
  });

  test("flatten concatenates page item arrays", async () => {
    const registry = registryFrom({
      pages: () => [{ items: ["a", "b"] }, { items: ["c"] }],
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "pages", kind: "tool", tool: "pages", args: {} }],
        returns: {
          kind: "transform",
          fn: "flatten",
          expr: "items",
          of: { kind: "from", step: "pages", path: "" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual(["a", "b", "c"]);
  });

  test("filter keeps items matching an assert expr", async () => {
    const registry = registryFrom({
      list: () => ({
        events: [
          { id: "1", level: "info" },
          { id: "2", level: "error" },
          { id: "3", level: "error" },
        ],
      }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "filter",
          expr: 'level == "error"',
          of: { kind: "from", step: "list", path: "events" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual([
      { id: "2", level: "error" },
      { id: "3", level: "error" },
    ]);
  });

  test("from.or seeds the first iteration then reads the prior result", async () => {
    const seen: unknown[] = [];
    const registry = registryFrom({
      page: ({ cursor }) => {
        seen.push(cursor);
        if (cursor == null) return { nextCursor: "1", items: ["a"] };
        return { nextCursor: null, items: ["b"] };
      },
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          {
            id: "loop",
            kind: "loop",
            over: { kind: "literal", value: [0] },
            item: "i",
            body: ["page"],
            until: "nextCursor == null",
            maxIters: 4,
            parallel: false,
          },
          {
            id: "page",
            kind: "tool",
            tool: "page",
            args: {
              cursor: { kind: "from", step: "page", path: "nextCursor", or: { kind: "literal", value: null } },
            },
          },
        ],
        returns: { kind: "from", step: "loop", path: "" },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(seen).toEqual([null, "1"]);
    expect((result.value as unknown[]).length).toBe(2);
  });

  test("unique keeps first-seen distinct by field, order preserved", async () => {
    const registry = registryFrom({
      list: () => ({
        rows: [
          { addr: "a", n: 1 },
          { addr: "b", n: 2 },
          { addr: "a", n: 3 },
          { addr: "c", n: 4 },
        ],
      }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "unique",
          expr: "addr",
          of: { kind: "from", step: "list", path: "rows" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual([
      { addr: "a", n: 1 },
      { addr: "b", n: 2 },
      { addr: "c", n: 4 },
    ]);
  });

  test("sort is stable and descending with a leading -", async () => {
    const registry = registryFrom({
      list: () => ({
        jobs: [
          { id: "c", prio: 1 },
          { id: "a", prio: 9 },
          { id: "b", prio: 5 },
        ],
      }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "sort",
          expr: "-prio",
          of: { kind: "from", step: "list", path: "jobs" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toEqual([
      { id: "a", prio: 9 },
      { id: "b", prio: 5 },
      { id: "c", prio: 1 },
    ]);
  });

  test("reduce sum:field and add integer", async () => {
    const registry = registryFrom({
      list: () => ({ lines: [{ amt: 10 }, { amt: 25 }, { amt: 5 }] }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "add",
          expr: "1",
          of: {
            kind: "transform",
            fn: "reduce",
            expr: "sum:amt",
            of: { kind: "from", step: "list", path: "lines" },
          },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toBe(41);
  });

  test("flatten deep:children collects leaves, one-level flatten unchanged", async () => {
    const tree = {
      path: "root",
      children: [
        { path: "a", children: [{ path: "a/f0" }, { path: "a/f1" }] },
        { path: "b", children: [{ path: "b/f0" }] },
      ],
    };
    const registry = registryFrom({
      list: () => ({ tree, sections: [{ blocks: ["x"] }, { blocks: ["y", "z"] }] }),
    });
    const deep = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "flatten",
          expr: "deep:children",
          of: { kind: "from", step: "list", path: "tree" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect((deep.value as Array<{ path: string }>).map((n) => n.path)).toEqual(["a/f0", "a/f1", "b/f0"]);

    const one = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [{ id: "list", kind: "tool", tool: "list", args: {} }],
        returns: {
          kind: "transform",
          fn: "flatten",
          expr: "blocks",
          of: { kind: "from", step: "list", path: "sections" },
        },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(one.value).toEqual(["x", "y", "z"]);
  });
});
