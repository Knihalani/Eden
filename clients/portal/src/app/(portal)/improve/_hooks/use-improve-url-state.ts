"use client";

/**
 * Improve hub URL-state wrapper around useSearchParams + improve-url helpers.
 */

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  clearImproveSelection,
  improveQueryString,
  improveSearchParamsEqual,
  normalizeImproveSearchParams,
  parseImproveSearchParams,
  writeImproveSearchParams,
  type ImproveUrlState,
} from "@/lib/improve-url";

export function useImproveUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo(
    () => parseImproveSearchParams(searchParams),
    [searchParams],
  );

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const normalized = normalizeImproveSearchParams(next);
      if (improveSearchParamsEqual(normalized, searchParams)) return;
      router.replace(
        `${window.location.pathname}${improveQueryString(normalized)}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const setState = useCallback(
    (patch: Partial<ImproveUrlState>, opts?: { replace?: boolean }) => {
      const next = writeImproveSearchParams(patch, searchParams);
      const normalized = normalizeImproveSearchParams(next);
      if (improveSearchParamsEqual(normalized, searchParams)) return;
      const url = `${window.location.pathname}${improveQueryString(normalized)}`;
      if (opts?.replace === false) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  const clearSelection = useCallback(() => {
    replaceParams(clearImproveSelection(searchParams));
  }, [replaceParams, searchParams]);

  return {
    state,
    setState,
    clearSelection,
    searchParams,
  };
}
