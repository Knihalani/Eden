"use client";

/**
 * Evals hub URL-state wrapper around useSearchParams + evals-url helpers.
 */

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  clearEvalsSelection,
  evalsQueryString,
  evalsSearchParamsEqual,
  normalizeEvalsSearchParams,
  parseEvalsSearchParams,
  writeEvalsSearchParams,
  type EvalsUrlState,
} from "@/lib/evals-url";

export function useEvalsUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo(
    () => parseEvalsSearchParams(searchParams),
    [searchParams],
  );

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const normalized = normalizeEvalsSearchParams(next);
      if (evalsSearchParamsEqual(normalized, searchParams)) return;
      router.replace(
        `${window.location.pathname}${evalsQueryString(normalized)}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const setState = useCallback(
    (patch: Partial<EvalsUrlState>, opts?: { replace?: boolean }) => {
      const next = writeEvalsSearchParams(patch, searchParams);
      const normalized = normalizeEvalsSearchParams(next);
      if (evalsSearchParamsEqual(normalized, searchParams)) return;
      const url = `${window.location.pathname}${evalsQueryString(normalized)}`;
      if (opts?.replace === false) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  const clearSelection = useCallback(() => {
    replaceParams(clearEvalsSelection(searchParams));
  }, [replaceParams, searchParams]);

  return {
    state,
    setState,
    clearSelection,
    searchParams,
  };
}
