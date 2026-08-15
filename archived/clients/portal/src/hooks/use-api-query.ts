"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

/**
 * The subset of React Query's ``QueryFunctionContext`` our wrapped
 * ``queryFn``s can rely on. Narrower than the real context (which
 * also carries ``queryKey`` / ``meta``) so a plain zero-arg closure
 * — ``() => api.getX(id)`` — remains a valid ``ApiQueryFn`` (TS
 * allows passing a function with fewer parameters than the target
 * type expects). Callers that want cancellation opt in by adding the
 * ``{ signal }`` parameter and threading it into the underlying
 * ``api.*``/``portalApi.*`` call (which accepts ``signal`` via
 * ``FetchOptions`` once it reaches ``fetchApi``); everyone else keeps
 * the exact previous behavior.
 */
export interface ApiQueryContext {
  signal: AbortSignal;
}

export type ApiQueryFn<T> = (context: ApiQueryContext) => Promise<T>;

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
 * parameters. The query function receives React Query's
 * ``{ signal }`` (unmount / query-key-change / refetch cancellation)
 * — ignore it (as most call sites do today) or thread it through to
 * the underlying ``api.*`` call to get real request cancellation.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  queryFn: ApiQueryFn<T>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">
) {
  return useQuery<T, Error>({
    queryKey: key as unknown[],
    queryFn: ({ signal }) => queryFn({ signal }),
    ...options });
}

/**
 * Org-scoped variant of ``useApiQuery``. Automatically disabled
 * (``enabled: false``) whenever ``orgId`` is falsy, so call sites
 * don't have to repeat ``enabled: Boolean(orgId)`` (and re-derive the
 * same guard) at every dashboard/observability/agents call site.
 *
 * ``queryFn`` is only ever invoked while ``orgId`` is truthy (the
 * query is disabled otherwise), so it's safe to assert non-null on
 * ``orgId`` inside the closure — e.g.
 *
 *   useOrgQuery(queryKeys.agents.list(orgId), orgId, () => agentsApi.list(orgId!))
 *
 * Callers can still pass their own ``enabled`` to layer on additional
 * conditions (e.g. "and a trace is selected") — both gates must be
 * true for the query to run.
 *
 * Like ``useApiQuery``, ``queryFn`` receives React Query's
 * ``{ signal }`` for opt-in cancellation.
 */
export function useOrgQuery<T>(
  key: readonly unknown[],
  orgId: string | null | undefined,
  queryFn: ApiQueryFn<T>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn" | "enabled"> & {
    enabled?: boolean;
  }
) {
  const { enabled, ...rest } = options ?? {};
  return useQuery<T, Error>({
    queryKey: key as unknown[],
    queryFn: ({ signal }) => queryFn({ signal }),
    enabled: Boolean(orgId) && (enabled ?? true),
    ...rest,
  });
}

/**
 * Org-scoped mutation wrapper for the imperative side of the data
 * layer (alerts ack, settings saves, approve/snooze in Improve,
 * etc.). Accepts ``invalidateKeys`` — an array of query-key
 * tuples/prefixes to invalidate on success — so call sites don't
 * hand-roll ``queryClient.invalidateQueries`` in every ``onSuccess``.
 *
 * A prefix invalidates every matching suffix (React Query does a
 * partial match on the key array), so passing
 * ``queryKeys.alerts.all`` invalidates every alerts query regardless
 * of orgId/filters, while ``queryKeys.alerts.list(orgId)`` only
 * invalidates that org's list.
 */
export function useOrgMutation<TData, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: Omit<UseMutationOptions<TData, Error, TVariables>, "mutationFn"> & {
    invalidateKeys?: Array<readonly unknown[]>;
  }
) {
  const queryClient = useQueryClient();
  const { invalidateKeys, onSuccess, ...rest } = options ?? {};
  return useMutation<TData, Error, TVariables>({
    mutationFn,
    onSuccess: (data, variables, onMutateResult, context) => {
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
      }
      return onSuccess?.(data, variables, onMutateResult, context);
    },
    ...rest,
  });
}
