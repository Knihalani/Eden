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
});
