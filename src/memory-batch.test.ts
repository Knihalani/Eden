/** P0.6: what one PostToolBatch records (A4 §5.5): paths, Bash exit codes and D10 error signatures. */
import { describe, expect, test } from "bun:test";
import { batchRecord, errorSignature } from "./memory-batch";

const call = (tool_name: string, tool_input: Record<string, unknown>, tool_response: unknown) => ({
  tool_name,
  tool_input,
  tool_use_id: "toolu_1",
  tool_response,
});

describe("A4 §5.5: the batch's ctx.log record", () => {
  test("the paths the calls name, each Bash exit code, and each failure's error signature", () => {
    const record = batchRecord({
      prompt_id: "p1",
      tool_calls: [
        call("Read", { file_path: "/repo/packages/cli/src/login.ts" }, "1\timport x"),
        call("Grep", { pattern: "auth", path: "/repo/apps/web" }, "apps/web/app/login.ts"),
        call("Bash", { command: "cd packages/cli && bun test" }, [{ type: "text", text: "12 pass" }]),
        call(
          "Bash",
          { command: "bun run build" },
          "Exit code 1\nbuilding…\nerror: Cannot find module './util' from '/repo/src/index.ts:12:3'",
        ),
      ],
    });
    expect(record).toEqual({
      prompt_id: "p1",
      paths: ["/repo/packages/cli/src/login.ts", "/repo/apps/web", "packages/cli"],
      exit: [0, 1],
      sig: ["error: Cannot find module '<path>' from '<path>:<loc>'"],
    });
  });

  test("D10: the same error in another file, line or run has one signature", () => {
    const one = errorSignature("Error [ERR_REQUIRE_ESM]: require() of /a/b/vitest.config.ts:3:9 not supported");
    const two = errorSignature("Error [ERR_REQUIRE_ESM]: require() of /c/vitest.config.mts:17:1 not supported");
    expect(one).toBe(two);
    expect(one).toContain("ERR_REQUIRE_ESM");
    expect(errorSignature("all 12 tests passed")).toBeUndefined();
  });

  test("a batch of many calls stays one line under 4 KB", () => {
    const calls = Array.from({ length: 40 }, (_, i) =>
      call("Bash", { command: `cd ${"d".repeat(300)}${i} && make` }, `Exit code 2\nerror: ${"e".repeat(400)} ${i}`),
    );
    expect(JSON.stringify(batchRecord({ tool_calls: calls })).length).toBeLessThan(4096);
  });
});
