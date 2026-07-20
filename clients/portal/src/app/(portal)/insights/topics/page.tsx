"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Layers, Loader2, Sparkles, Database, Bell, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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

export default function TopicsPage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [facet, setFacet] = useState<Facet>("task");
  const [view, setView] = useState<ViewMode>("list");
  const [actingId, setActingId] = useState<string | null>(null);
  const [actOpenId, setActOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useOrgQuery(
    queryKeys.topics.list(orgId, facet),
    orgId,
    () => api.listTopics(orgId!, facet),
  );

  const generate = useMutation({
    mutationFn: () => api.generateTopics(orgId!, facet),
    onSuccess: () => void refetch(),
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
        await refetch();
      } catch (err) {
        toast.error(
          action === "dataset" ? "Create dataset failed" : "Online rule failed",
          err instanceof Error ? err.message : "Could not act on topic.",
        );
      } finally {
        setActingId(null);
      }
    },
    [orgId, refetch, toast],
  );

  const topics: Topic[] = data?.topics ?? [];

  const scatterBounds = useMemo(() => {
    const maxShare = Math.max(1, ...topics.map((t) => t.share_pct ?? 0));
    const maxSamples = Math.max(1, ...topics.map((t) => t.sample_count ?? 0));
    return { maxShare, maxSamples };
  }, [topics]);

  if (!orgId) {
    return (
      <NoOrgState
        icon={Layers}
        feature="Topics"
        description="Topic clusters appear after enough production traffic."
      />
    );
  }

  return (
    <PageContent>
      {!embedded ? (
        <PageHeader
          eyebrow="Analyze"
          title="Topics"
          subtitle="Intent and issue clusters from production traffic."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="View mode"
                className="inline-flex rounded-lg border border-[var(--border-default)] p-1"
              >
                {(["list", "scatter"] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={view === mode ? "default" : "ghost"}
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
                disabled={generate.isPending || isFetching}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate
              </Button>
            </div>
          }
        />
      ) : (
        <div className="mb-space-3 flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="View mode"
            className="inline-flex rounded-lg border border-[var(--border-default)] p-1"
          >
            {(["list", "scatter"] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={view === mode ? "default" : "ghost"}
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
            disabled={generate.isPending || isFetching}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Generate
          </Button>
        </div>
      )}

      <Tabs value={facet} onValueChange={(v) => setFacet(v as Facet)}>
        <TabsList
          variant={embedded ? "pills" : "underline"}
          aria-label="Topic facets"
          className={
            embedded
              ? "h-auto w-full justify-start gap-1 overflow-x-auto"
              : "h-auto w-full justify-start"
          }
        >
          {FACETS.map((f) => (
            <TabsTrigger key={f.id} value={f.id} variant={embedded ? "pills" : "underline"}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <LoadingSkeleton variant="table" lines={5} />
      ) : isError ? (
        <ErrorState
          title="Could not load topics"
          message={error?.message ?? "Topics could not be loaded. Try again."}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : topics.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No topics yet"
          description="Topics appear after enough production traffic. Generate a first run when ready."
          size="lg"
        />
      ) : view === "scatter" ? (
        <div
          className="relative h-72 rounded-xl bg-[var(--bg-secondary)]"
          data-testid="u11-topics-scatter"
          role="img"
          aria-label="Topics scatter: share % vs sample count"
        >
          <span className="absolute bottom-2 left-2 text-2xs text-[var(--text-muted)]">
            Share % →
          </span>
          <span className="absolute left-2 top-2 text-2xs text-[var(--text-muted)]">
            Samples ↑
          </span>
          {topics.map((t) => {
            const x = ((t.share_pct ?? 0) / scatterBounds.maxShare) * 88 + 6;
            const y =
              100 - ((t.sample_count ?? 0) / scatterBounds.maxSamples) * 80 - 8;
            return (
              <button
                key={t.id}
                type="button"
                title={`${t.name} · ${t.sample_count} traces · ${t.share_pct ?? 0}%`}
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] hover:ring-2 hover:ring-[var(--accent)]"
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => setActOpenId(actOpenId === t.id ? null : t.id)}
              />
            );
          })}
          {actOpenId ? (
            <ActMenu
              topic={topics.find((t) => t.id === actOpenId)!}
              acting={actingId === actOpenId}
              orgId={orgId}
              onAct={runAct}
              onClose={() => setActOpenId(null)}
            />
          ) : null}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-default)]">
          {topics.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-[var(--text-primary)]">
                  {t.name}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {t.sample_count} traces
                  {t.share_pct != null ? ` · ${t.share_pct}% share` : ""}
                </p>
                {t.representative_trace_ids?.[0] && (
                  <Link
                    href={`/traces/${t.representative_trace_ids[0]}?org=${orgId}`}
                    className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline"
                  >
                    Open sample trace
                  </Link>
                )}
              </div>
              <div className="relative">
                <Button
                  size="sm"
                  variant="outline"
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
                    orgId={orgId}
                    onAct={runAct}
                    onClose={() => setActOpenId(null)}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContent>
  );
}

function ActMenu({
  topic,
  acting,
  orgId,
  onAct,
  onClose,
}: {
  topic: Topic;
  acting: boolean;
  orgId: string;
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
          href={`/traces/${topic.representative_trace_ids[0]}?org=${orgId}`}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
          onClick={onClose}
        >
          Open traces
        </Link>
      ) : null}
    </div>
  );
}
