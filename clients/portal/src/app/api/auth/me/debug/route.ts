/**
 * GET /api/auth/me/debug — return the decoded Clerk session payload.
 *
 * Diagnostic endpoint: when /auth/me is returning 404 "User not found"
 * but the user is in the DB, the most likely cause is a mismatch
 * between the Clerk session's ``sub`` claim and the ``users.clerk_id``
 * column (typically because the user signed up with a different email
 * and is on a fresh Clerk account that hasn't been auto-provisioned
 * yet). This route exposes the decoded JWT payload so the user can
 * see what Clerk is sending us, and so the operator can correlate it
 * against the ``users`` table.
 *
 * The response includes the raw payload fields Clerk ships in the
 * default session token (``sub``, ``iss``, ``iat``, ``exp``, ...).
 * If the session is missing or invalid, returns 401 with a clear
 * reason. NEVER logged on the server — the payload can contain PII
 * the operator should not have on disk.
 *
 * Public (no Clerk middleware) so it can be called from the auth-card
 * without a session round-trip.
 */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  try {
    const { userId, sessionClaims, getToken } = await auth();
    if (!userId) {
      return NextResponse.json(
        {
          authenticated: false,
          reason: "No Clerk session",
        },
        { status: 401 },
      );
    }
    // Decoded claims straight from the JWT — this is what the backend
    // sees when /auth/me is called.
    const token = await getToken();
    return NextResponse.json(
      {
        authenticated: true,
        userId,
        sessionClaims: sessionClaims ?? null,
        tokenPresent: Boolean(token),
        // The shape the backend's _resolve_token_payload cares about:
        //   user_id  — pulled from sub / user_id / uid
        //   email    — pulled from email (only present if the Clerk
        //              JWT template includes it)
        backendUserId:
          (sessionClaims as { sub?: string } | null)?.sub ?? null,
        backendEmail:
          (sessionClaims as { email?: string } | null)?.email ?? null,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        authenticated: false,
        reason: "Clerk middleware error",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
