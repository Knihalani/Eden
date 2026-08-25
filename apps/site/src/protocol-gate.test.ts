import { describe, expect, test } from "bun:test";
import { handleFetch } from "./server";
import { EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER } from "@eden/ir";

/**
 * The /v1/* protocol gate: a mismatched wire version is refused with 426 and
 * an explanation; matching and absent versions proceed to normal handling.
 *
 * Deliberately touches NO database: unauthenticated /v1 requests answer 401
 * before any SQL runs, which is exactly the observable needed to prove the
 * gate passed a request through. Other suites in this directory share the
 * process env, so this one must not set EDEN_DB/EDEN_DEV.
 */
describe("/v1 protocol gate", () => {
  const base = "http://127.0.0.1:8787/v1/tools";
  test("health reports the protocol version", async () => {
    const res = await handleFetch(new Request("http://127.0.0.1:8787/health"));
    const j = (await res.json()) as { protocol?: number };
    expect(j.protocol).toBe(EDEN_PROTOCOL_VERSION);
    expect(res.headers.get(PROTOCOL_HEADER)).toBe(String(EDEN_PROTOCOL_VERSION));
  });

  test("mismatched client version is refused with 426 and both numbers named — before auth even runs", async () => {
    const res = await handleFetch(
      new Request(base, { headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION + 99) } }),
    );
    expect(res.status).toBe(426);
    const j = (await res.json()) as { error?: string };
    expect(j.error).toContain(`client speaks ${EDEN_PROTOCOL_VERSION + 99}`);
    expect(j.error).toContain(`server speaks ${EDEN_PROTOCOL_VERSION}`);
  });

  test("matching and absent versions proceed to normal handling (never 426)", async () => {
    // /v1/setup answers from env alone — no database, no auth — so the ONLY
    // thing this proves is that the gate passed the request through. Its
    // status is env-dependent (200 on a laptop, 401 on a deployment).
    const matched = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/setup", {
        method: "POST",
        headers: { host: "127.0.0.1:8787", [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) },
        body: "{}",
      }),
    );
    expect(matched.status).not.toBe(426);
    // Legacy client: no header at all — must keep working.
    const legacy = await handleFetch(
      new Request("http://127.0.0.1:8787/v1/setup", { method: "POST", headers: { host: "127.0.0.1:8787" }, body: "{}" }),
    );
    expect(legacy.status).not.toBe(426);
  });
});
