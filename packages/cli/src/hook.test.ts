import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");

describe("hook hot path", () => {
  test("allow path does not call the network", () => {
    const env = { ...process.env, EDEN_HOME: join(import.meta.dir, "../../.tmp-eden-test") };
    const started = Date.now();
    const r = spawnSync("bun", [cli, "hook"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "t1",
        tool_name: "Read",
        tool_input: { file_path: "a.ts" },
      }),
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout || "{}")).toEqual({});
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
