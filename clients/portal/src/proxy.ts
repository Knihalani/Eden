import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Protected-first: block everything, allow the routes that must stay
// reachable without a session (marketing pages, auth flows, the
// catch-all proxy to FastAPI, and Clerk's own internal callbacks).
const isPublicRoute = createRouteMatcher([
  "/",
  "/login(.*)",
  "/signup(.*)",
  "/forgot-password(.*)",
  "/reset-password(.*)",
  "/invite(.*)",
  "/docs(.*)",
  "/api/proxy(.*)",
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
