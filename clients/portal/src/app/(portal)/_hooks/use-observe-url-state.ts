"use client";

/**
 * Thin Observe URL-state wrapper around useSearchParams + observe-url helpers.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  clearObserveSelection,
  legacyObserveExternalRedirect,
  normalizeObserveSearchParams,
  observeQueryString,
  observeSearchParamsEqual,
  parseObserveSearchParams,
  progressiveEscClear,
  writeObserveSearchParams,
  type ObserveUrlState,
} from "@/lib/observe-url";

export function useObserveUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Legacy Tools: view=replay|debug|time-travel → /debugger (IA §3.4).
  useEffect(() => {
    const dest = legacyObserveExternalRedirect(searchParams);
    if (dest) router.replace(dest);
  }, [router, searchParams]);

  const state = useMemo(
    () => parseObserveSearchParams(searchParams),
    [searchParams],
  );

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const normalized = normalizeObserveSearchParams(next);
      if (observeSearchParamsEqual(normalized, searchParams)) return;
      router.replace(
        `${window.location.pathname}${observeQueryString(normalized)}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const setState = useCallback(
    (patch: Partial<ObserveUrlState>, opts?: { replace?: boolean }) => {
      const next = writeObserveSearchParams(patch, searchParams);
      const normalized = normalizeObserveSearchParams(next);
      if (observeSearchParamsEqual(normalized, searchParams)) return;
      const url = `${window.location.pathname}${observeQueryString(normalized)}`;
      if (opts?.replace === false) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  const clearSelection = useCallback(
    (
      level?:
        | "span"
        | "trace"
        | "session"
        | "issue"
        | "alert"
        | "all",
    ) => {
      replaceParams(clearObserveSelection(searchParams, level ?? "all"));
    },
    [replaceParams, searchParams],
  );

  const escClear = useCallback(() => {
    replaceParams(progressiveEscClear(searchParams));
  }, [replaceParams, searchParams]);

  return {
    state,
    setState,
    clearSelection,
    escClear,
    searchParams,
  };
}
