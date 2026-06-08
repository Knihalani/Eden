"use client";

/**
 * useUrlState — type-safe URL query-parameter state.
 *
 * Phase 7.2 (C7): replaces hand-rolled useSearchParams glue in the
 * observability page. Reads the current value from the URL on
 * mount, updates the URL on every change (via ``router.replace``,
 * which doesn't add a history entry — back-button still works
 * through the app's natural navigation).
 *
 * Usage:
 *   const [activeTab, setActiveTab] = useUrlState<Tab>("tab", "traces");
 *   const [traceId, setTraceId] = useUrlState<string>("trace", "");
 *
 * For multiple keys, prefer ``useUrlStateMulti`` which reads
 * ``URLSearchParams`` once and returns a setter for any key.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function useUrlState<T extends string>(
  key: string,
  defaultValue: T,
  options: { allowed?: readonly T[] } = {},
): [T, (next: T) => void] {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get(key);
  let value: T = defaultValue;
  if (isString(raw) && raw.length > 0) {
    if (options.allowed) {
      if ((options.allowed as readonly string[]).includes(raw)) {
        value = raw as T;
      }
    } else {
      value = raw as T;
    }
  }
  const setValue = React.useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === defaultValue || next === "") {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      const qs = params.toString();
      const url = qs ? `?${qs}` : "";
      router.replace(`${window.location.pathname}${url}`, { scroll: false });
    },
    [router, searchParams, key, defaultValue],
  );
  return [value, setValue];
}

/**
 * Hook that exposes a generic setter for any URL key. Useful when
 * a component needs to read/write 3+ parameters without 3+
 * hook subscriptions.
 */
export function useUrlSearch(): {
  get: (key: string) => string | null;
  set: (key: string, value: string | null) => void;
  all: URLSearchParams;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const all = React.useMemo(
    () => new URLSearchParams(searchParams.toString()),
    [searchParams],
  );
  const get = React.useCallback(
    (key: string) => all.get(key),
    [all],
  );
  const set = React.useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      const qs = params.toString();
      const url = qs ? `?${qs}` : "";
      router.replace(`${window.location.pathname}${url}`, { scroll: false });
    },
    [router, searchParams],
  );
  return { get, set, all };
}
