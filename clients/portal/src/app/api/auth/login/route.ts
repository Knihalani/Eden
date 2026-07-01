
import { forwardToBackend, proxyError } from "@/lib/proxy";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    // Read any existing session cookie so backend calls stay sticky
    // during the login flow.
    const cookieHeader = request.headers.get("cookie") ?? undefined;
    return await forwardToBackend("/auth/login", {
      method: "POST",
      body,
      cookieHeader });
  } catch (error) {
    return proxyError(error, "Login failed");
  }
}
