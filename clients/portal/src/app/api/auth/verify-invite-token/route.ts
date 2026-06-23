import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const upstream = `/v1/auth/verify-invite-token?token=${encodeURIComponent(token)}`;
    return await forwardToBackend(upstream, {
      method: "GET",
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "Invite token verification failed");
  }
}
