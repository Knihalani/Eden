"use client";

import { useAuth, useSession } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { continuePath, SEE_PENDING } from "./home";

export function useContinueIfAuthed() {
  const { isLoaded, isSignedIn, orgId } = useAuth(SEE_PENDING);
  const { session } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    router.replace(continuePath(session?.status, orgId));
  }, [isLoaded, isSignedIn, orgId, session?.status, router]);

  return { isLoaded, isSignedIn };
}
