import { afterAll, describe, expect, mock, test } from "bun:test";

/**
 * approveTool / pauseTool / resumeTool / dismissRequest drive the embedded
 * control plane with a shared bearer token, so Clerk is the only real gate.
 * The gate lives in plane(), shared by every action — these tests prove an
 * unauthenticated or workspace-less caller gets refused before any
 * control-plane request is built.
 */

const authState: { userId: string | null; orgId: string | null; sessionStatus: string } = {
  userId: null,
  orgId: null,
  sessionStatus: "active",
};

let wrapCalls = 0;
const lastHeaders: Record<string, string> = {};
let lastBody = "";
let lastUrl = "";

mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({
    userId: authState.userId,
    orgId: authState.orgId,
    sessionStatus: authState.sessionStatus,
  }),
}));

mock.module("next/cache", () => ({
  revalidatePath: () => undefined,
}));

mock.module("@/lib/wrap", () => ({
  wrapFetch: () => async (req: Request) => {
    wrapCalls++;
    lastUrl = req.url;
    req.headers.forEach((v, k) => {
      lastHeaders[k] = v;
    });
    lastBody = await req.text();
    return Response.json({ ok: true });
  },
}));

const { approveTool, pauseTool, promoteTool, resumeTool, dismissRequest, bindWorkspaceOrg } = await import("./actions");

/**
 * The credential helper reads the environment at call time, so pin it for the
 * whole file: bun auto-loads this repo's .env (which carries DATABASE_URL),
 * and under those managed markers edenKey() correctly refuses eden_dev.
 */
const savedEnv = Object.fromEntries(
  ["DATABASE_URL", "VERCEL", "EDEN_API_KEY", "EDEN_DEV"].map((k) => [k, process.env[k]]),
);
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
process.env.EDEN_API_KEY = "test_key";

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function signedIn() {
  authState.userId = "user_1";
  authState.orgId = "org_1";
  authState.sessionStatus = "active";
}

function signedOut() {
  authState.userId = null;
  authState.orgId = null;
}

describe("canvas server actions auth gate", () => {
  // wrapCalls is module-scoped; --randomize reorders these tests, so each case
  // must start from a known counter (absolute expects, not suite order).
  function resetCalls() {
    wrapCalls = 0;
    lastBody = "";
    lastUrl = "";
    for (const k of Object.keys(lastHeaders)) delete lastHeaders[k];
  }

  test("an anonymous visitor cannot approve", async () => {
    resetCalls();
    signedOut();
    const out = await approveTool("tool_1");
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    expect(wrapCalls).toBe(0);
  });

  test("a session without an active workspace cannot pause or dismiss", async () => {
    resetCalls();
    authState.userId = "user_1";
    authState.orgId = null;
    const p = await pauseTool("tool_1");
    const d = await dismissRequest("cand_1");
    expect(p.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(wrapCalls).toBe(0);
  });

  test("a pending session cannot resume", async () => {
    resetCalls();
    authState.userId = "user_1";
    authState.orgId = "org_1";
    authState.sessionStatus = "pending";
    const out = await resumeTool("tool_1");
    expect(out.ok).toBe(false);
    expect(wrapCalls).toBe(0);
  });

  test("a signed-in active member reaches the control plane", async () => {
    resetCalls();
    signedIn();
    const out = await approveTool("tool_1");
    expect(out.ok).toBe(true);
    expect(wrapCalls).toBe(1);
  });

  test("approve can carry the Write-serve checkbox", async () => {
    resetCalls();
    signedIn();
    const out = await approveTool("tool_1", [], [], { transparentWrites: true });
    expect(out.ok).toBe(true);
    expect(JSON.parse(lastBody)).toEqual({ transparent_writes: true });
  });

  test("the action carries the caller's org id as x-eden-org", async () => {
    resetCalls();
    signedIn();
    authState.orgId = "org_9";
    const out = await approveTool("tool_1");
    expect(out.ok).toBe(true);
    expect(lastHeaders["x-eden-org"]).toBe("org_9");
  });

  test("bindWorkspaceOrg registers the caller's org", async () => {
    resetCalls();
    signedIn();
    authState.orgId = "org_7";
    const out = await bindWorkspaceOrg();
    expect(out.ok).toBe(true);
    expect(lastHeaders["x-eden-org"]).toBe("org_7");
  });

  test("promote posts /v1/tools/:id/promote", async () => {
    resetCalls();
    signedIn();
    const out = await promoteTool("tool_1");
    expect(out.ok).toBe(true);
    expect(lastUrl).toMatch(/\/v1\/tools\/tool_1\/promote$/);
  });

  test("approve can carry dropValues and pinIslands", async () => {
    resetCalls();
    signedIn();
    const out = await approveTool("tool_1", [], [], {
      dropValues: [{ path: "id", value: "T-2" }],
      pinIslands: true,
    });
    expect(out.ok).toBe(true);
    expect(JSON.parse(lastBody)).toEqual({
      dropValues: [{ path: "id", value: "T-2" }],
      pinIslands: true,
    });
  });

  test("no eden_dev fallback on a managed install without EDEN_API_KEY", async () => {
    resetCalls();
    const env = {
      DATABASE_URL: process.env.DATABASE_URL,
      VERCEL: process.env.VERCEL,
      EDEN_API_KEY: process.env.EDEN_API_KEY,
      EDEN_DEV: process.env.EDEN_DEV,
    };
    try {
      process.env.DATABASE_URL = "postgres://managed";
      delete process.env.VERCEL;
      delete process.env.EDEN_API_KEY;
      delete process.env.EDEN_DEV;
      signedIn();
      const callsBefore = wrapCalls;
      const out = await approveTool("tool_1");
      expect(out.ok).toBe(false);
      expect(out.error).toContain("EDEN_API_KEY");
      expect(wrapCalls).toBe(callsBefore);
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
