"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import Link from "next/link";

export function AccountOther({ page }: { page: "signin" | "signup" }) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { signOut } = useClerk();

  if (isLoaded && isSignedIn) {
    return (
      <nav className="hero-nav" aria-label="Account">
        <button
          type="button"
          className="signin"
          onClick={() => {
            void signOut({ redirectUrl: "/" });
          }}
        >
          Sign out
        </button>
      </nav>
    );
  }

  return (
    <nav className="hero-nav" aria-label="Account">
      {page === "signin" ? (
        <Link href="/sign-in" className="signin">
          Sign in
        </Link>
      ) : (
        <Link href="/sign-up" className="signin">
          Sign up
        </Link>
      )}
    </nav>
  );
}
