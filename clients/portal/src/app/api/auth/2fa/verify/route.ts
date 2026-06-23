import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return await forwardToBackend("/v1/auth/2fa/verify", {
      method: "POST",
      body,
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "2FA verification failed");
  }
}
