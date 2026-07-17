"use client";

import { useEffect, useRef } from "react";
import { markEden } from "./marks";

/** Mark `eden:page` once per route mount (F82). */
export function usePagePerf(route: string): void {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    markEden("eden:page", route);
  }, [route]);
}

/** Mark `eden:table_query` when a table query settles. */
export function useTableQueryPerf(
  route: string,
  isFetching: boolean,
  isLoading: boolean,
): void {
  const pending = useRef(false);
  useEffect(() => {
    if (isLoading || isFetching) {
      pending.current = true;
      return;
    }
    if (!pending.current) return;
    pending.current = false;
    markEden("eden:table_query", route);
  }, [route, isFetching, isLoading]);
}
