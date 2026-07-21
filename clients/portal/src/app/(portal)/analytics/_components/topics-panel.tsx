"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  Database,
  Layers,
  Loader2,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { useToast } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { traceHref } from "@/lib/portal-cross-links";

type Facet = "task" | "sentiment" | "issues";
type ViewMode = "list" | "scatter";

const FACETS: { id: Facet; label: string }[] = [
  { id: "task", label: "Task" },
  { id: "sentiment", label: "Sentiment" },
  { id: "issues", label: "Issues" },
];

type Topic = {
  id: string;
  name: string;
  sample_count: number;
  share_pct: number | null;
  representative_trace_ids?: string[];
};

/** Dense Topics leaf for Analytics — QueryState + compact rows. */
export function TopicsPanel() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [facet, setFacet] = useState<Facet>("task");
  const [view, setView] = useState<ViewMode>("list");
  const [actingId, setActingId] = useState<string | null>(null);
  const [actOpenId, setActOpenId] = useState<string | null>(null);

  const query = useOrgQuery(
    queryKeys.topics.list(orgId, facet),
    orgId,
    () => api.listTopics(orgId!, facet),
  );

  const generate = useMutation({
    mutationFn: () => api.generateTopics(orgId!, facet),
    onSuccess: () => void query.refetch(),
    onError: (err) => {
      toast.error(
        "Generate failed",
        err instanceof Error ? err.message : "Could not generate topics.",
      );
    },
  });

  const runAct = useCallback(
    async (topicId: string, action: "dataset" | "alert", name: string) => {
      if (!orgId) return;
      setActingId(topicId);
      setActOpenId(null);
      try {
        await api.actOnTopic(orgId, topicId, { action, name });
        await query.refetch();
      } catch (err) {
        toast.error(
          action === "dataset" ? "Create dataset failed" : "Online rule failed",
          err instanceof Error ? err.message : "Could not act on topic.",
        );
      } finally {
        setActingId(null);
      }
    },
    [orgId, query, toast],
  );

  const topics: Topic[] = query.data?.topics ?? [];

  const scatterBounds = useMemo(() => {
    const maxShare = Math.max(1, ...topics.map((t) => t.share_pct ?? 0));
    const maxSamples = Math.max(1, ...topics.map((t) => t.sample_count ?? 0));
    return { maxShare, maxSamples };
  }, [topics]);

  if (!orgId) {
    return (
      <EmptyState
        icon={Layers}
        title="Select an organization"
        description="Topic clusters appear after enough production traffic."
        size="md"
      />
    );
  }

  return (
    <div data-testid="analytics-topics-panel" data-wave6-analytics="topics-dense" data-wave7-analytics="one-job">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Tabs value={facet} onValueChange={(v) => setFacet(v as Facet)}>
          <TabsList
            variant="underline"
            aria-label="Topic facets"
            className="h-auto justify-start gap-1 bg-transparent"
          >
            {FACETS.map((f) => (
              <TabsTrigger key={f.id} value={f.id} variant="underline">
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div
          role="group"
          aria-label="View mode"
          className="inline-flex rounded-lg border border-[var(--border-default)] p-0.5"
        >
          {(["list", "scatter"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={view === mode ? "secondary" : "ghost"}
              aria-pressed={view === mode}
              className="capitalize"
              onClick={() => setView(mode)}
            >
              {mode}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={generate.isPending || query.isFetching}
          onClick={() => generate.mutate()}
          className="ml-auto"
        >
          {generate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Generate
        </Button>
      </div>

      <div className="mt-2">
        <QueryState
          loading={query.isLoading}
          error={query.error}
          data={query.data}
          onRetry={() => void query.refetch()}
          isEmpty={(d) => (d?.topics?.length ?? 0) === 0}
          emptySlot={
            <EmptyState
              icon={Layers}
              title="No topics yet"
              description="Topics appear after enough production traffic. Generate a first run when ready."
              size="md"
            />
          }
          errorTitle="Could not load topics"
        >
          {() =>
            view === "scatter" ? (
              <div
                className="relative h-64 rounded-lg bg-[var(--bg-secondary)]"
                data-testid="u11-topics-scatter"
                role="img"
                aria-label="Topics scatter: share % vs sample count"
              >
                <span className="absolute bottom-2 left-2 text-xs text-[var(--text-muted)]">
                  Share % →
                </span>
                <span className="absolute left-2 top-2 text-xs text-[var(--text-muted)]">
                  Samples ↑
                </span>
                {topics.map((t) => {
                  const x = ((t.share_pct ?? 0) / scatterBounds.maxShare) * 88 + 6;
                  const y =
                    100 -
                    ((t.sample_count ?? 0) / scatterBounds.maxSamples) * 80 -
                    8;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      title={`${t.name} · ${t.sample_count} traces`}
                      className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]"
                      style={{ left: `${x}%`, top: `${y}%` }}
                      onClick={() =>
                        setActOpenId(actOpenId === t.id ? null : t.id)
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)]">
                {topics.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {t.name}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {t.sample_count} traces
                        {t.share_pct != null ? ` · ${t.share_pct}%` : ""}
                        {t.representative_trace_ids?.[0] ? (
                          <>
                            {" · "}
                            <Link
                              href={traceHref(t.representative_trace_ids[0])}
                              className="text-[var(--accent)] hover:underline"
                            >
                              sample
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="relative shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actingId === t.id}
                        aria-haspopup="menu"
                        aria-expanded={actOpenId === t.id}
                        onClick={() =>
                          setActOpenId(actOpenId === t.id ? null : t.id)
                        }
                      >
                        {actingId === t.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        Act
                      </Button>
                      {actOpenId === t.id ? (
                        <ActMenu
                          topic={t}
                          acting={actingId === t.id}
                          onAct={runAct}
                          onClose={() => setActOpenId(null)}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryState>
      </div>
    </div>
  );
}

function ActMenu({
  topic,
  acting,
  onAct,
  onClose,
}: {
  topic: Topic;
  acting: boolean;
  onAct: (id: string, action: "dataset" | "alert", name: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      data-testid="u11-act-menu"
      className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] p-1 shadow-md"
    >
      <button
        type="button"
        role="menuitem"
        disabled={acting}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
        onClick={() =>
          void onAct(topic.id, "dataset", `topic-${topic.name.slice(0, 30)}`)
        }
      >
        <Database className="h-3.5 w-3.5" />
        Create dataset
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={acting}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
        onClick={() =>
          void onAct(topic.id, "alert", `topic-alert-${topic.name.slice(0, 24)}`)
        }
      >
        <Bell className="h-3.5 w-3.5" />
        Online rule
      </button>
      {topic.representative_trace_ids?.[0] ? (
        <Link
          role="menuitem"
          href={traceHref(topic.representative_trace_ids[0])}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
          onClick={onClose}
        >
          Open sample
        </Link>
      ) : null}
    </div>
  );
}
