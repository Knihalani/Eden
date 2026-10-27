import { describe, expect, test } from "bun:test";
import { probeBrowserOrigin, probeHookdNoArm, probePostBatchRemainder } from "./post-batch";

describe("PostToolBatch remainder (Wave 15.4)", () => {
  test("parallel siblings execute mutating step once", async () => {
    const r = await probePostBatchRemainder();
    expect(r.batchDecision).toBeUndefined();
    expect(r.via).toBe("curl");
    expect(r.grepDenied).toBe(true);
    expect(r.writeDenied).toBe(true);
    expect(r.mutate).toBe(1);
  });

  test("empty live catalog and unique-work do not deny through hookd", async () => {
    const empty = await probeHookdNoArm([]);
    expect(empty.via).toBe("curl");
    expect(empty.grepDenied).toBe(false);
    expect(empty.writeDenied).toBe(false);
    const unique = await probeHookdNoArm([{ name: "fetch_then_bash", sequence: ["WebFetch", "Bash"], id: "t-unique" }]);
    expect(unique.grepDenied).toBe(false);
    expect(unique.writeDenied).toBe(false);
  });

  test("browser Origin does not ride the Claude hop", async () => {
    expect(await probeBrowserOrigin()).toBe(403);
  });
});
