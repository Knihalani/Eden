"use client";

/**
 * Guardrails hub URL-state wrapper around useSearchParams + guardrails-url helpers.
 */

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  clearGuardrailsSelection,
  guardrailsQueryString,
  guardrailsSearchParamsEqual,
  normalizeGuardrailsSearchParams,
  parseGuardrailsSearchParams,
  writeGuardrailsSearchParams,
  type GuardrailsUrlState,
} from "@/lib/guardrails-url";

export function useGuardrailsUrlState() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state = useMemo(
    () => parseGuardrailsSearchParams(searchParams),
    [searchParams],
  );

  const replaceParams = useCallback(
    (next: URLSearchParams) => {
      const normalized = normalizeGuardrailsSearchParams(next);
      if (guardrailsSearchParamsEqual(normalized, searchParams)) return;
      router.replace(
        `${window.location.pathname}${guardrailsQueryString(normalized)}`,
        { scroll: false },
      );
    },
    [router, searchParams],
  );

  const setState = useCallback(
    (patch: Partial<GuardrailsUrlState>, opts?: { replace?: boolean }) => {
      const next = writeGuardrailsSearchParams(patch, searchParams);
      const normalized = normalizeGuardrailsSearchParams(next);
      if (guardrailsSearchParamsEqual(normalized, searchParams)) return;
      const url = `${window.location.pathname}${guardrailsQueryString(normalized)}`;
      if (opts?.replace === false) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, searchParams],
  );

  const clearSelection = useCallback(() => {
    replaceParams(clearGuardrailsSelection(searchParams));
  }, [replaceParams, searchParams]);

  return {
    state,
    setState,
    clearSelection,
    searchParams,
  };
}
