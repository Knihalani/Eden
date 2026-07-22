"use client";

/**
 * /debugger — DebuggerSession list + create.
 * Not a core sidebar leaf; reached via Traces action / Cmd+K / More.
 */

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { debugSessionsApi } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { debuggerDetailHref } from "@/lib/debugger-url";

const SESSIONS_QK = "debugger-sessions";

function DebuggerPageInner() {
  const t = useTranslations("debugger");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { role } = usePermissions();
  const canCreate = role !== "viewer";
  const queryClient = useQueryClient();

  const seedTraceId = searchParams.get("traceId") ?? undefined;
  const [q, setQ] = useState(searchParams.get("q") ?? "");

  const sessionsQuery = useQuery({
    queryKey: [SESSIONS_QK, orgId],
    queryFn: () => debugSessionsApi.list(orgId!),
    enabled: Boolean(orgId),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (body: { title?: string; source_trace_id?: string }) =>
      debugSessionsApi.create(orgId!, body),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [SESSIONS_QK, orgId] });
      if (res.session?.id) {
        router.push(debuggerDetailHref(res.session.id));
      }
    },
  });

  const handleNew = () => {
    createMutation.mutate({
      title: seedTraceId ? `Debug ${seedTraceId.slice(0, 8)}` : undefined,
      source_trace_id: seedTraceId,
    });
  };

  const sessions = sessionsQuery.data?.sessions ?? [];
  const filtered = q
    ? sessions.filter((s) =>
        (s.title ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : sessions;

  return (
    <div className="flex flex-col gap-4" data-phase6-debugger="live">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canCreate ? (
            <Button
              size="sm"
              onClick={handleNew}
              disabled={createMutation.isPending}
              aria-label={t("newSession")}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {createMutation.isPending ? t("creating") : t("newSession")}
            </Button>
          ) : null
        }
      />

      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search")}
            className="pl-8 text-sm"
            aria-label={t("search")}
          />
        </div>
      </div>

      {seedTraceId ? (
        <p className="text-xs text-[var(--text-muted)]">
          {t("seedHint", { traceId: seedTraceId })}
        </p>
      ) : null}

      <QueryState
        loading={sessionsQuery.isLoading}
        error={sessionsQuery.error}
        data={sessionsQuery.data}
        onRetry={() => void sessionsQuery.refetch()}
        isEmpty={() => filtered.length === 0}
        filtersActive={Boolean(q)}
        emptySlot={
          <EmptyState
            title={t("empty.title")}
            description={t("empty.body")}
            action={
              canCreate ? (
                <Button size="sm" onClick={handleNew}>
                  {t("newSession")}
                </Button>
              ) : undefined
            }
          />
        }
        filterEmptySlot={
          <EmptyState
            title={t("filterEmpty.title")}
            description={t("filterEmpty.body")}
            action={
              <Button size="sm" variant="secondary" onClick={() => setQ("")}>
                {t("filterEmpty.clear")}
              </Button>
            }
          />
        }
      >
        {() => (
          <div className="overflow-hidden rounded-md border border-[var(--border-default)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-tertiary)]">
                  <th className="px-4 py-2 text-left text-xs font-medium text-[var(--text-muted)]">
                    {t("col.title")}
                  </th>
                  <th className="hidden px-4 py-2 text-left text-xs font-medium text-[var(--text-muted)] sm:table-cell">
                    {t("col.source")}
                  </th>
                  <th className="hidden px-4 py-2 text-left text-xs font-medium text-[var(--text-muted)] md:table-cell">
                    {t("col.updated")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((session) => (
                  <tr
                    key={session.id}
                    className="cursor-pointer border-b border-[var(--border-subtle)] hover:bg-[var(--bg-tertiary)]"
                    onClick={() => router.push(debuggerDetailHref(session.id))}
                  >
                    <td className="px-4 py-3 font-medium text-[var(--text-primary)]">
                      {session.title || t("untitled")}
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs text-[var(--text-muted)] sm:table-cell">
                      {session.source_trace_id
                        ? `${session.source_trace_id.slice(0, 12)}…`
                        : "—"}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-[var(--text-muted)] md:table-cell">
                      {session.updated_at
                        ? formatRelativeTime(session.updated_at)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export default function DebuggerPage() {
  return (
    <Suspense>
      <DebuggerPageInner />
    </Suspense>
  );
}
