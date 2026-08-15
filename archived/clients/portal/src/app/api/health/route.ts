/**
 * GET /api/health — lean probe to FastAPI `/health`.
 *
 * Intentionally does **not** import `@/lib/proxy` (circuit breaker, auth
 * header assembly, large module graph). Cold portal isolates used to pay
 * ~2s extra vs direct `api.edenobservability.com/health` (~0.3s).
 *
 * Soft-degraded rewrite: upstream 503 + soft body → HTTP 200 with the
 * same JSON so auth-card badges avoid DevTools 503 noise. Hard failures
 * stay 503.
 */
import { NextResponse } from "next/server";
import { isSoftDegradedHealth } from "@/lib/health-status";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const NO_STORE = "no-store, no-cache, must-revalidate";
const UPSTREAM_TIMEOUT_MS = 4_000;

function apiBase(): string {
  return (
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:8000"
  ).replace(/\/$/, "");
}

export async function GET() {
  const base = apiBase();
  // Prefer absolute API host — NEXT_PUBLIC_API_URL is often `/api/proxy`.
  const upstream =
    base.startsWith("http") && !base.includes("/api/proxy")
      ? `${base}/health`
      : `${process.env.API_INTERNAL_URL || "https://api.edenobservability.com"}/health`;

  try {
    const response = await fetch(upstream, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { status: "unknown", raw: text.slice(0, 200) };
    }

    if (response.status === 503 && isSoftDegradedHealth(body)) {
      return NextResponse.json(body, {
        status: 200,
        headers: { "Cache-Control": NO_STORE },
      });
    }

    return new NextResponse(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": NO_STORE,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Backend health check failed";
    return NextResponse.json(
      { status: "unhealthy", error: message },
      { status: 503, headers: { "Cache-Control": NO_STORE } },
    );
  }
}
