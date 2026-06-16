import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function GET(request: Request) {
  try {
    return await forwardToBackend("/auth/me", {
      method: "GET",
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "Not authenticated");
  }
}
