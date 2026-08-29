import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { productGate } from "./app/account/route";
import { hasClerkSession } from "./lib/session-cookie";

const isPublicNotes = createRouteMatcher(["/isolation(.*)", "/proof(.*)", "/pack(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const path = req.nextUrl.pathname;

  // Public notes are documents. Do not start a session handshake.
  if (isPublicNotes(req)) {
    return NextResponse.next();
  }

  // Marketing HTML can be CDN-cached when nobody is signed in. A session cookie
  // still takes the dynamic path so we can send them to /home.
  if (path === "/" && !hasClerkSession(req.cookies)) {
    return NextResponse.next();
  }

  const { isAuthenticated, sessionStatus, orgId } = await auth({ treatPendingAsSignedOut: false });
  const dest = productGate({ path, isAuthenticated, sessionStatus, orgId });
  if (dest) return NextResponse.redirect(new URL(dest, req.url));
});

export const config = {
  matcher: [
    // Wrap (`/v1`, `/health`) is bearer-token, not Clerk. Matching it here
    // forced a session handshake and Set-Cookie on every tool call.
    "/((?!_next|v1(?:/|$)|health(?:/|$)|isolation(?:/|$)|proof(?:/|$)|pack(?:/|$)|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
