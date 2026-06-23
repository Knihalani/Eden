import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function POST(request: Request) {
  try {
    return await forwardToBackend("/v1/auth/2fa/disable", {
      method: "POST",
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "2FA disable failed");
  }
}
