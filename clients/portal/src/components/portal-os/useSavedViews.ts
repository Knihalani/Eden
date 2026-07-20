"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { savedViewsApi, type SavedViewRecord } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";

/**
 * Laminar table-views ViewState (§C.1).
 * Dirty when filters OR sort OR columns diverge from the active saved view / Default.
 */
export type ViewState = {
  q?: string;
  filter?: Record<string, string>;
  sort?: { key: string; direction: "asc" | "desc" };
  columns?: string[];
  pastHours?: string;
};

function compactFilter(
  filter: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!filter) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (v != null && String(v).length > 0) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Stable JSON for compare — filters, sort, and columns all participate. */
export function normalizeViewState(state: ViewState | null | undefined): {
  q: string;
  filter: Record<string, string>;
  sort: { key: string; direction: "asc" | "desc" } | null;
  columns: string[];
  pastHours: string;
} {
  return {
    q: state?.q?.trim() ?? "",
    filter: compactFilter(state?.filter) ?? {},
    sort: state?.sort?.key
      ? { key: state.sort.key, direction: state.sort.direction ?? "asc" }
      : null,
    columns: Array.isArray(state?.columns) ? [...state.columns] : [],
    pastHours: state?.pastHours ?? "",
  };
}

export function viewStatesEqual(
  a: ViewState | null | undefined,
  b: ViewState | null | undefined,
): boolean {
  return JSON.stringify(normalizeViewState(a)) === JSON.stringify(normalizeViewState(b));
}

/**
 * Dirty when current ≠ baseline.
 * `baseline` null/undefined = built-in Default (empty ViewState).
 */
export function isViewDirty(
  current: ViewState,
  baseline: ViewState | null | undefined,
): boolean {
  return !viewStatesEqual(current, baseline ?? {});
}

function viewFromRecord(rec: SavedViewRecord): ViewState {
  const params = rec.params ?? {};
  return {
    q: typeof params.q === "string" ? params.q : rec.query !== "(all)" ? rec.query : undefined,
    filter:
      params.filter && typeof params.filter === "object"
        ? (params.filter as Record<string, string>)
        : undefined,
    sort:
      params.sort && typeof params.sort === "object"
        ? (params.sort as ViewState["sort"])
        : undefined,
    columns: Array.isArray(params.columns) ? (params.columns as string[]) : undefined,
    pastHours: typeof params.pastHours === "string" ? params.pastHours : undefined,
  };
}

export function useSavedViews(resource: string) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["saved-views", orgId, resource],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const res = await savedViewsApi.list(orgId!, resource);
      return res.searches ?? [];
    },
    staleTime: 60_000,
  });

  const views = useMemo(
    () => (listQuery.data ?? []).map((v) => ({ ...v, state: viewFromRecord(v) })),
    [listQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      state: ViewState;
      is_shared?: boolean;
    }) => {
      if (!orgId) throw new Error("no org");
      return savedViewsApi.create(orgId, {
        name: input.name,
        resource,
        state: input.state,
        is_shared: input.is_shared,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", orgId, resource] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      viewId: string;
      state: ViewState;
      name?: string;
      is_shared?: boolean;
    }) => {
      if (!orgId) throw new Error("no org");
      return savedViewsApi.update(orgId, input.viewId, {
        name: input.name,
        resource,
        state: input.state,
        is_shared: input.is_shared,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", orgId, resource] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (viewId: string) => {
      if (!orgId) throw new Error("no org");
      await savedViewsApi.delete(orgId, viewId);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["saved-views", orgId, resource] });
    },
  });

  const resolveView = useCallback(
    (viewId: string | undefined): ViewState | null => {
      if (!viewId) return null;
      const hit = views.find((v) => v.id === viewId);
      return hit?.state ?? null;
    },
    [views],
  );

  return {
    views,
    loading: listQuery.isLoading,
    save: saveMutation.mutateAsync,
    update: updateMutation.mutateAsync,
    remove: deleteMutation.mutateAsync,
    resolveView,
    refetch: listQuery.refetch,
  };
}
