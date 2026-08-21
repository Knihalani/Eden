import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { hasClerkSession } from "./lib/session-cookie";

const isAuthPage = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);
const isWorkspace = createRouteMatcher(["/workspace(.*)"]);
const isAuthFlow = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/sso-callback(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;

  // Marketing HTML can be CDN-cached when nobody is signed in. A session cookie
  // still takes the dynamic path so we can send them to /home.
  if (path === "/" && !hasClerkSession(req.cookies)) {
    return NextResponse.next();
  }

  const { isAuthenticated, sessionStatus, orgId } = await auth({ treatPendingAsSignedOut: false });
  const pending = sessionStatus === "pending";
  const needsWorkspace = pending || Boolean(isAuthenticated && sessionStatus === "active" && !orgId);
  const inProduct = Boolean(isAuthenticated && sessionStatus === "active" && orgId);

  if (inProduct && (isAuthPage(req) || path === "/")) {
    return NextResponse.redirect(new URL("/home", req.url));
  }

  if (isAuthPage(req) && needsWorkspace) {
    return NextResponse.redirect(new URL("/workspace", req.url));
  }

  if (needsWorkspace && !isWorkspace(req) && !isAuthFlow(req)) {
    return NextResponse.redirect(new URL("/workspace", req.url));
  }
});

export const config = {
  matcher: [
    // Wrap (`/v1`, `/health`) is bearer-token, not Clerk. Matching it here
    // forced a session handshake and Set-Cookie on every tool call.
    "/((?!_next|v1(?:/|$)|health(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
