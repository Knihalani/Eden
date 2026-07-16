import { describe, expect, it } from "vitest";
import { EdenSDK } from "../src/client.js";
import { optimizationOptOutHeaders } from "../src/gateway_optimizations.js";

describe("gateway optimizations", () => {
  it("optimizationOptOutHeaders is quiet when all enabled", () => {
    expect(optimizationOptOutHeaders({})).toEqual({});
  });

  it("optimizationOptOutHeaders emits false only for disabled features", () => {
    expect(
      optimizationOptOutHeaders({ exactCache: false, responseRepair: false }),
    ).toEqual({
      "X-Eden-Exact-Cache": "false",
      "X-Eden-Response-Repair": "false",
    });
  });

  it("EdenSDK.gatewayHeaders includes opt-out headers from config", () => {
    const sdk = new EdenSDK({
      orgId: "org-1",
      apiKey: "k",
      exactCache: false,
    });
    const headers = sdk.gatewayHeaders();
    expect(headers["X-Eden-Exact-Cache"]).toBe("false");
    expect(headers["X-Eden-Coalesce"]).toBeUndefined();
  });
});
