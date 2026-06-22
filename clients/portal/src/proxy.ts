import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Protected-first: block everything, allow the routes that must stay
// reachable without a session (marketing pages, auth flows, the
// catch-all proxy to FastAPI, and Clerk's own internal callbacks).
//
// /api/health is a public, unauthenticated health probe so uptime
// monitors and the auth-card status badge can call it without
// needing a Clerk session. /api/auth/me and /api/auth/refresh are
// the proxy's own Clerk-aware endpoints — they accept ANY token
// (Clerk JWT, Eden cookie, anonymous) and decide themselves, so
// they must NOT be gated by Clerk middleware. /api/auth/login + /signup
// are the legacy Eden cookie flow, also unauthenticated.
const isPublicRoute = createRouteMatcher([
  "/",
  "/login(.*)",
  "/signup(.*)",
  "/forgot-password(.*)",
  "/reset-password(.*)",
  "/invite(.*)",
  "/docs(.*)",
  "/api/proxy/(.*)",  // explicit / after proxy so the matcher sees
                        // segments, not just a trailing string
  "/api/health",
  "/api/auth/me",
  "/api/auth/refresh",
  "/api/auth/me/debug",
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout",
  "/__clerk(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Run on everything except Next internals + static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run on API + TRPC routes.
    "/(api|trpc)(.*)",
    // Always run on Clerk's own auto-proxy path (after the API matcher).
    "/__clerk/:path*",
  ],
};
