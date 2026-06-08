import { NextResponse } from "next/server";

/**
 * Standard error response for proxy route handlers. Preserves a 401 from the
 * backend (so the client's setUnauthorizedHandler can react) instead of
 * collapsing every failure to a generic 500.
 */
export function proxyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = message === "Not authenticated" ? 401 : 500;
  return NextResponse.json({ detail: message }, { status });
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface ForwardOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  cookieHeader?: string;
}

/**
 * Forward a request to FastAPI and return a NextResponse that carries over
 * the backend's Set-Cookie headers. Use this in auth proxy routes — the
 * shared `api.ts` client discards response headers, which would drop the
 * session cookie and leave the browser unauthenticated after login.
 */
export async function forwardToBackend(
  path: string,
  options: ForwardOptions = {}
): Promise<NextResponse> {
  const { method = "POST", body, cookieHeader } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cookieHeader) headers["Cookie"] = cookieHeader;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Read the body once — clone before reading so the body is also available
  // for forwarding set-cookie logic.
  const responseBody = await response.text();
  let parsed: unknown = null;
  if (responseBody) {
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = { detail: responseBody };
    }
  }

  const nextResponse = NextResponse.json(parsed ?? {}, {
    status: response.status,
  });

  // Forward every Set-Cookie header from FastAPI. Next.js's
  // NextResponse.cookies is the supported path — using `headers.append`
  // directly would emit duplicate Set-Cookie headers with the same name.
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [pair, ...attrs] = cookie.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    nextResponse.cookies.set({
      name,
      value,
      httpOnly: attrs.some((a) => a.toLowerCase() === "httponly"),
      secure: attrs.some((a) => a.toLowerCase() === "secure"),
      sameSite: (attrs.find((a) => a.toLowerCase().startsWith("samesite="))?.split("=")[1] ?? "lax") as "lax" | "strict" | "none",
      path: attrs.find((a) => a.toLowerCase().startsWith("path="))?.split("=")[1] ?? "/",
      maxAge: Number(attrs.find((a) => a.toLowerCase().startsWith("max-age="))?.split("=")[1] ?? "0") || undefined,
    });
  }

  return nextResponse;
}
