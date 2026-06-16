import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function POST(request: Request) {
  try {
    return await forwardToBackend("/auth/logout", {
      method: "POST",
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "Logout failed");
  }
}
