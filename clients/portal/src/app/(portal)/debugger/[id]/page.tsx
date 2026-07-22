"use client";

/**
 * /debugger/[id] — DebuggerSession workspace.
 * Modes: Replay | Compare | Time-travel | Notes
 */

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  GitCompare,
  Clock,
  StickyNote,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useAiSessionContext } from "@/components/ai-agent/ai-session-provider";
import { debuggerApi, debugSessionsApi } from "@/lib/api";
import {
  parseDebuggerDetailParams,
  type DebuggerMode,
} from "@/lib/debugger-url";

const SESSION_QK = "debugger-session";
const CHECKPOINTS_QK = "debugger-checkpoints";

function DebuggerDetailInner() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useTranslations("debugger.detail");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const { role } = usePermissions();
  const canCreate = role !== "viewer";
  const { openAi } = useAiSessionContext();
  const queryClient = useQueryClient();

  const urlParams = parseDebuggerDetailParams(searchParams);
  const [activeMode, setActiveMode] = useState<DebuggerMode>(
    urlParams.mode ?? "replay",
  );
  const [notes, setNotes] = useState("");
  const [rerunResult, setRerunResult] = useState<string | null>(null);
  const [leftTraceId, setLeftTraceId] = useState(urlParams.leftTraceId ?? "");
  const [rightTraceId, setRightTraceId] = useState(
    urlParams.rightTraceId ?? "",
  );

  const sessionQuery = useQuery({
    queryKey: [SESSION_QK, orgId, sessionId],
    queryFn: () => debugSessionsApi.get(orgId!, sessionId),
    enabled: Boolean(orgId) && Boolean(sessionId),
  });

  const session = sessionQuery.data?.session;

  const checkpointsQuery = useQuery({
    queryKey: [CHECKPOINTS_QK, orgId, session?.source_trace_id],
    queryFn: () =>
      debuggerApi.listCheckpoints(orgId!, session!.source_trace_id!),
    enabled: Boolean(orgId) && Boolean(session?.source_trace_id),
  });

  const rerunMutation = useMutation({
    mutationFn: (body: { trace_id: string }) => debuggerApi.rerun(orgId!, body),
    onSuccess: (res) => {
      setRerunResult(JSON.stringify(res, null, 2));
      void queryClient.invalidateQueries({
        queryKey: [SESSION_QK, orgId, sessionId],
      });
    },
  });

  const compareMutation = useMutation({
    mutationFn: ({ runA, runB }: { runA: string; runB: string }) =>
      debugSessionsApi.compare(orgId!, sessionId, runA, runB),
  });

  const handleAskAi = () => {
    openAi({
      prompt: `Explain what happened in debugger session ${session?.title ?? sessionId}`,
    });
  };

  const handleModeChange = (mode: DebuggerMode) => {
    setActiveMode(mode);
    const p = new URLSearchParams(searchParams.toString());
    p.set("mode", mode);
    router.replace(
      `/debugger/${encodeURIComponent(sessionId)}?${p.toString()}`,
      { scroll: false },
    );
  };

  const checkpoints = checkpointsQuery.data?.checkpoints ?? [];
  const sourceTraceId = session?.source_trace_id;

  return (
    <div className="flex flex-col gap-4" data-phase6-debugger-detail="live">
      <PageHeader
        title={session?.title ?? t("titleFallback")}
        subtitle={
          sourceTraceId
            ? `${t("sourceTrace")}: ${sourceTraceId.slice(0, 16)}…`
            : t("noSource")
        }
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleAskAi}>
              <MessageSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {t("askAi")}
            </Button>
            {sourceTraceId ? (
              <Button size="sm" variant="ghost" asChild>
                <Link
                  href={`/traces?traceId=${encodeURIComponent(sourceTraceId)}&mode=transcript`}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("openTrace")}
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      <QueryState
        loading={sessionQuery.isLoading}
        error={sessionQuery.error}
        data={sessionQuery.data}
        onRetry={() => void sessionQuery.refetch()}
        isEmpty={(d) => !d?.session}
        emptySlot={
          <EmptyState title={t("notFound")} description={t("notFoundBody")} />
        }
      >
        {() => (
          <>
            <Tabs
              value={activeMode}
              onValueChange={(v) => handleModeChange(v as DebuggerMode)}
            >
              <TabsList>
                <TabsTrigger value="replay">
                  <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("modes.replay")}
                </TabsTrigger>
                <TabsTrigger value="compare">
                  <GitCompare className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("modes.compare")}
                </TabsTrigger>
                <TabsTrigger value="time-travel">
                  <Clock className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("modes.timeTravel")}
                </TabsTrigger>
                <TabsTrigger value="notes">
                  <StickyNote className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("modes.notes")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="replay" className="pt-4">
                <div className="flex flex-col gap-4 lg:flex-row">
                  <aside className="w-full shrink-0 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] lg:w-[280px]">
                    <div className="border-b border-[var(--border-subtle)] px-3 py-2">
                      <p className="text-xs font-medium text-[var(--text-muted)]">
                        {t("replay.checkpoints")}
                      </p>
                    </div>
                    {checkpointsQuery.isLoading ? (
                      <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
                        {t("replay.loadingCheckpoints")}
                      </p>
                    ) : checkpoints.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-[var(--text-muted)]">
                        {t("replay.noCheckpoints")}
                      </p>
                    ) : (
                      <ul className="divide-y divide-[var(--border-subtle)]">
                        {checkpoints.map((cp, i) => (
                          <li
                            key={i}
                            className="px-3 py-2 text-xs text-[var(--text-secondary)]"
                          >
                            {t("replay.step", { step: i + 1 })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </aside>
                  <div className="flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
                    {sourceTraceId ? (
                      <>
                        <p className="mb-3 text-sm text-[var(--text-secondary)]">
                          {t("replay.desc")}
                        </p>
                        {canCreate ? (
                          <Button
                            size="sm"
                            onClick={() =>
                              rerunMutation.mutate({
                                trace_id: sourceTraceId,
                              })
                            }
                            disabled={rerunMutation.isPending}
                          >
                            <Play
                              className="mr-1.5 h-3.5 w-3.5"
                              aria-hidden
                            />
                            {rerunMutation.isPending
                              ? t("replay.running")
                              : t("replay.run")}
                          </Button>
                        ) : (
                          <p className="text-xs text-[var(--text-muted)]">
                            {t("replay.viewerHint")}
                          </p>
                        )}
                        {rerunResult ? (
                          <pre className="mt-4 max-h-64 overflow-auto rounded bg-[var(--bg-inset)] p-2 text-xs">
                            {rerunResult}
                          </pre>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-sm text-[var(--text-muted)]">
                        {t("replay.noTrace")}
                      </p>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="compare" className="pt-4">
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-[var(--text-secondary)]">
                    {t("compare.desc")}
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs text-[var(--text-muted)]">
                        {t("compare.leftTrace")}
                      </label>
                      <input
                        value={leftTraceId}
                        onChange={(e) => setLeftTraceId(e.target.value)}
                        className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1.5 text-sm min-h-11"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="mb-1 block text-xs text-[var(--text-muted)]">
                        {t("compare.rightTrace")}
                      </label>
                      <input
                        value={rightTraceId}
                        onChange={(e) => setRightTraceId(e.target.value)}
                        className="w-full rounded border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 py-1.5 text-sm min-h-11"
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={
                        !leftTraceId ||
                        !rightTraceId ||
                        compareMutation.isPending
                      }
                      onClick={() =>
                        compareMutation.mutate({
                          runA: leftTraceId,
                          runB: rightTraceId,
                        })
                      }
                    >
                      {compareMutation.isPending
                        ? t("compare.comparing")
                        : t("compare.run")}
                    </Button>
                  </div>
                  {compareMutation.data ? (
                    <pre className="max-h-80 overflow-auto rounded bg-[var(--bg-inset)] p-3 text-xs">
                      {JSON.stringify(compareMutation.data, null, 2)}
                    </pre>
                  ) : null}
                </div>
              </TabsContent>

              <TabsContent value="time-travel" className="pt-4">
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-[var(--text-secondary)]">
                    {t("timeTravel.desc")}
                  </p>
                  {checkpoints.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <label className="text-xs text-[var(--text-muted)]">
                        {t("timeTravel.scrubber")}
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(checkpoints.length - 1, 0)}
                        step={1}
                        defaultValue={0}
                        className="w-full accent-[var(--accent)]"
                        aria-label={t("timeTravel.scrubber")}
                      />
                      <p className="text-xs text-[var(--text-muted)]">
                        {t("timeTravel.stepCount", {
                          count: checkpoints.length,
                        })}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">
                      {sourceTraceId
                        ? t("timeTravel.noCheckpoints")
                        : t("timeTravel.noTrace")}
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="notes" className="pt-4">
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-[var(--text-secondary)]">
                    {t("notes.desc")}
                  </p>
                  <Textarea
                    value={notes || session?.notes || ""}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t("notes.placeholder")}
                    rows={8}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-[var(--text-muted)]">
                    {t("notes.localHint")}
                  </p>
                </div>
              </TabsContent>
            </Tabs>

            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-4">
              <span className="text-xs text-[var(--text-muted)]">
                {t("related.label")}
              </span>
              {sourceTraceId ? (
                <Button size="sm" variant="ghost" asChild>
                  <Link
                    href={`/traces?traceId=${encodeURIComponent(sourceTraceId)}&mode=transcript`}
                  >
                    {t("related.traces")}
                  </Link>
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <Link href="/issues">{t("related.issues")}</Link>
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link href="/improve">{t("related.improve")}</Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={handleAskAi}>
                {t("related.askAi")}
              </Button>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

export default function DebuggerDetailPage() {
  return (
    <Suspense>
      <DebuggerDetailInner />
    </Suspense>
  );
}
