"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * Thin React Query wrapper around the typed ``api`` client.
 *
 * Use this anywhere you'd otherwise write:
 *   useEffect(() => { api.getX().then(setX) }, [])
 *
 * Like:
 *   const { data, error, isLoading } = useApiQuery(["x", id], () => api.getX(id));
 *
 * The query key is an array — the convention is
 *   [resourceName, ...identifiers, ...filterArgs]
 * so the in-flight cache correctly dedupes GETs with identical
 * parameters. The query function receives no arguments; close over
 * anything you need from the React scope.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">
) {
  return useQuery<T, Error>({
    queryKey: key as unknown[],
    queryFn,
    ...options,
  });
}
