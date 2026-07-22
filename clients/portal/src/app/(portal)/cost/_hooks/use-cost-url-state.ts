"use client";

/**
 * Cost hub URL-state wrapper around useSearchParams + cost-url helpers.
 */

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  clearCostSelection,
  costQueryString,
  costSearchParamsEqual,
  normalizeCostSearchParams,
  parseCostSearchParams,
  writeCostSearchParams,
  type CostUrlState,
} from "@/lib/cost-url";

export function useCostUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo(
    () => parseCostSearchParams(searchParams),
    [searchParams],
  );

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const normalized = normalizeCostSearchParams(next);
      if (costSearchParamsEqual(normalized, searchParams)) return;
      router.replace(
        `${window.location.pathname}${costQueryString(normalized)}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const setState = useCallback(
    (patch: Partial<CostUrlState>, opts?: { replace?: boolean }) => {
      const next = writeCostSearchParams(patch, searchParams);
      const normalized = normalizeCostSearchParams(next);
      if (costSearchParamsEqual(normalized, searchParams)) return;
      const url = `${window.location.pathname}${costQueryString(normalized)}`;
      if (opts?.replace === false) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  const clearSelection = useCallback(() => {
    replaceParams(clearCostSelection(searchParams));
  }, [replaceParams, searchParams]);

  return {
    state,
    setState,
    clearSelection,
    searchParams,
  };
}
