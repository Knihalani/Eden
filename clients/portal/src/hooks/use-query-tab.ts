"use client";

import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

/** Read/write a single query param used as a page tab or view switcher. */
export function useQueryTab<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get(key);
  const value = (allowed.includes(raw as T) ? raw : fallback) as T;

  const setValue = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname);
    },
    [router, pathname, searchParams, key, fallback],
  );

  return [value, setValue];
}
