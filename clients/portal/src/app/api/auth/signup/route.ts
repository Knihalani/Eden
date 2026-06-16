import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return await forwardToBackend("/auth/signup", {
      method: "POST",
      body,
      cookieHeader: request.headers.get("cookie") ?? undefined,
    });
  } catch (error) {
    return proxyError(error, "Signup failed");
  }
}
