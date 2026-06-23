import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function GET(request: Request) {
  try {
    return await forwardToBackend("/v1/auth/2fa/status", {
      method: "GET",
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "2FA status failed");
  }
}
