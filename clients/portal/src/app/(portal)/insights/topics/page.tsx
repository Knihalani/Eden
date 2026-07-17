"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Layers, Loader2, Sparkles, Database, Bell, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";

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
  const orgId = currentOrg?.id;
  const [facet, setFacet] = useState<Facet>("task");
  const [view, setView] = useState<ViewMode>("list");
  const [actingId, setActingId] = useState<string | null>(null);
  const [actOpenId, setActOpenId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["topics", orgId, facet],
    queryFn: () => api.listTopics(orgId!, facet),
    enabled: Boolean(orgId),
  });

  const generate = useMutation({
    mutationFn: () => api.generateTopics(orgId!, facet),
    onSuccess: () => void refetch(),
  });

  const runAct = useCallback(
    async (topicId: string, action: "dataset" | "alert", name: string) => {
      if (!orgId) return;
      setActingId(topicId);
      setActOpenId(null);
      try {
        await api.actOnTopic(orgId, topicId, { action, name });
        await refetch();
      } finally {
        setActingId(null);
      }
    },
    [orgId, refetch],
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
    <div className="space-y-6 p-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">
            Topics
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Intent and issue clusters from production traffic. Drill into traces
            or act on a cluster.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="View mode"
            className="inline-flex rounded-lg border border-[var(--border-default)] p-0.5"
          >
            {(["list", "scatter"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                className={`px-3 py-1.5 rounded-md text-sm capitalize ${
                  view === mode
                    ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                    : "text-[var(--text-muted)]"
                }`}
                onClick={() => setView(mode)}
              >
                {mode}
              </button>
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
            <span className="ml-2">Generate</span>
          </Button>
        </div>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Topic facets">
        {FACETS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={facet === f.id}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              facet === f.id
                ? "bg-[var(--bg-tertiary)] border-[var(--border-default)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
            onClick={() => setFacet(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading topics…
        </div>
      ) : topics.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No topics yet"
          description="Topics appear after enough production traffic. Generate a first run when ready."
          size="lg"
        />
      ) : view === "scatter" ? (
        <div
          className="relative h-72 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]"
          data-testid="u11-topics-scatter"
          role="img"
          aria-label="Topics scatter: share % vs sample count"
        >
          <span className="absolute left-2 bottom-2 text-[10px] text-[var(--text-muted)]">
            Share % →
          </span>
          <span className="absolute left-2 top-2 text-[10px] text-[var(--text-muted)] rotate-0">
            Samples ↑
          </span>
          {topics.map((t) => {
            const x =
              ((t.share_pct ?? 0) / scatterBounds.maxShare) * 88 + 6;
            const y =
              100 -
              ((t.sample_count ?? 0) / scatterBounds.maxSamples) * 80 -
              8;
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
        <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-default)]">
          {topics.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-[var(--text-primary)] truncate">
                  {t.name}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {t.sample_count} traces
                  {t.share_pct != null ? ` · ${t.share_pct}% share` : ""}
                </p>
                {t.representative_trace_ids?.[0] && (
                  <Link
                    href={`/traces/${t.representative_trace_ids[0]}?org=${orgId}`}
                    className="text-xs text-[var(--accent)] hover:underline mt-1 inline-block"
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
                  <span className="ml-1.5">Act</span>
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
    </div>
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
