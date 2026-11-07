import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { edenId } from "@eden/client";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";

// The Python client (eden_client/, D278): its unit tests, then the same calls end to end against the real handler,
// and its `eden_id` against the TypeScript `edenId` (one user must get one id from either language).

const dir = join(import.meta.dir, "..");
const python = Bun.which("python3");
const run = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn([python!, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe.skipIf(!python)("eden_client (Python)", () => {
  test("its unit tests pass", async () => {
    const { err, code } = await run(["-m", "unittest", "test_eden_client"]);
    expect(err).toContain("OK");
    expect(code).toBe(0);
  }, 30_000);

  test("end to end against the real handler: health, observe, collect, ask, explain, forwarded items", async () => {
    const key = "k_python_0123456789ab";
    const crm = new StaticSource("crm", "deals", [
      { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" },
    ]);
    const partner = buildPartner({ sources: async () => [crm], model: null });
    const server = Bun.serve({
      port: 0,
      fetch: createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false }),
    });
    try {
      const script = `
import json, sys
from eden_client import EdenClient, with_context
errors = []
eden = EdenClient(api_key=sys.argv[2], user_id="u1", session_id="s1", base_url=sys.argv[1], on_error=errors.append)
bad = EdenClient(api_key="k_wrong_0123456789ab", user_id="u1", session_id="s1", base_url=sys.argv[1])
r = eden.observe({"kind": "user_message", "text": "Globex renewal with Dana Lee"}, wait_ms=1000)
msgs = with_context([{"role": "user", "content": "hi"}], eden.collect(r["injection"]))
print(json.dumps({
  "health": eden.health(), "bad": bad.health(),
  "cited": [c["itemId"] for c in (r["injection"] or {}).get("citations", [])],
  "roles": [m["role"] for m in msgs],
  "ask": [c["itemId"] for c in eden.ask("What does Dana Lee want?")["citations"]],
  "explain": [d["decision"] for d in eden.explain()],
  "notice": eden.source_notice("crm"),
  "errors": [str(e) for e in errors],
}))`;
      const { out, err, code } = await run(["-c", script, server.url.href.replace(/\/$/, ""), key]);
      expect(err).toBe("");
      expect(code).toBe(0);
      const got = JSON.parse(out);
      expect(got.health).toEqual({ ok: true });
      expect(got.bad).toEqual({ ok: false, error: "eden /v1/whoami: 401 missing or unknown API key" });
      expect(got.cited).toContain("crm:d1");
      expect(got.roles).toEqual(["system", "user"]);
      expect(got.ask).toContain("crm:d1");
      expect(got.explain.length).toBeGreaterThan(0);
      expect(got.notice.synced).toBe(false);
      expect(got.errors).toEqual([]);
    } finally {
      server.stop(true);
      partner.stopSync();
    }
  }, 30_000);

  test("eden_id gives the TypeScript edenId's id for every input", async () => {
    const raws = [
      "alice",
      "alice+work@x.com",
      "e:x",
      "h:y",
      "chat/123",
      "a b",
      "\ud800",
      "�",
      "é",
      "日本",
      "😀",
      "_",
      "x".repeat(128),
      "y".repeat(129),
      "+".repeat(40),
      "Ünïcödé user 42",
      "abc\n",
      "\n",
    ];
    const { out, code } = await run([
      "-c",
      "import json,sys\nfrom eden_client import eden_id\n" +
        "print(json.dumps([eden_id(r) for r in json.loads(sys.argv[1])]))",
      JSON.stringify(raws),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(raws.map(edenId));
  }, 30_000);
});
