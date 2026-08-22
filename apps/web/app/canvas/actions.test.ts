import { describe, expect, mock, test } from "bun:test";

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
  wrapFetch: () => (req: Request) => {
    wrapCalls++;
    return Promise.resolve(Response.json({ ok: true }));
  },
}));

const { approveTool, pauseTool, resumeTool, dismissRequest } = await import("./actions");

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
  test("an anonymous visitor cannot approve", async () => {
    signedOut();
    const out = await approveTool("tool_1");
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
    expect(wrapCalls).toBe(0);
  });

  test("a session without an active workspace cannot pause or dismiss", async () => {
    authState.userId = "user_1";
    authState.orgId = null;
    const p = await pauseTool("tool_1");
    const d = await dismissRequest("cand_1");
    expect(p.ok).toBe(false);
    expect(d.ok).toBe(false);
    expect(wrapCalls).toBe(0);
  });

  test("a pending session cannot resume", async () => {
    authState.userId = "user_1";
    authState.orgId = "org_1";
    authState.sessionStatus = "pending";
    const out = await resumeTool("tool_1");
    expect(out.ok).toBe(false);
    expect(wrapCalls).toBe(0);
  });

  test("a signed-in active member reaches the control plane", async () => {
    signedIn();
    const out = await approveTool("tool_1");
    expect(out.ok).toBe(true);
    expect(wrapCalls).toBe(1);
  });
});
