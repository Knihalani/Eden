"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { savedViewsApi, type SavedViewRecord } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";

export type ViewState = {
  q?: string;
  filter?: Record<string, string>;
  sort?: { key: string; direction: "asc" | "desc" };
  columns?: string[];
  pastHours?: string;
};

function viewFromRecord(rec: SavedViewRecord): ViewState {
  const params = rec.params ?? {};
  return {
    q: typeof params.q === "string" ? params.q : rec.query,
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
    remove: deleteMutation.mutateAsync,
    resolveView,
    refetch: listQuery.refetch,
  };
}
