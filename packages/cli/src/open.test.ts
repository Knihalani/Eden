import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { knockWorkshopUrl, rejectTool } from "./open";

describe("approvals: open / reject (Arc 2 catcher)", () => {
  test("knock with tool_id opens that workshop card; missing/corrupt falls back to root", () => {
    expect(knockWorkshopUrl("http://127.0.0.1:8787", { tool_id: "t_abc" })).toBe(
      "http://127.0.0.1:8787/workshop/t_abc",
    );
    expect(knockWorkshopUrl("http://127.0.0.1:8787", {})).toBe("http://127.0.0.1:8787/workshop");
    expect(knockWorkshopUrl("http://127.0.0.1:8787", null)).toBe("http://127.0.0.1:8787/workshop");
  });

  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.EDEN_HOME;
    home = mkdtempSync(join(tmpdir(), "eden-open-"));
    process.env.EDEN_HOME = home;
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8787" }),
    );
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("rejectTool POSTs knock/reject and unlinks knock.json even when the plane is down", async () => {
    const knock = join(home, "knock.json");
    writeFileSync(knock, JSON.stringify({ tool_id: "t_gone" }));
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch;
    try {
      await rejectTool();
      expect(existsSync(knock)).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
