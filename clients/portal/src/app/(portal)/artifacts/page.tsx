"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import { Download, Loader2, Package, PenLine, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import {
  CoreResourcePage,
  DetailPanelShell,
  BulkActionBar,
  useResourceUrlState,
  ResourceOsToolbar,
} from "@/components/portal-os";
import { ArtifactDetailPanel, type ArtifactDetail } from "@/components/artifacts/ArtifactDetailPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { learnApi } from "@/lib/api";
import { issueHref } from "@/lib/portal-cross-links";
import { errorFromCaught } from "@/lib/safe-error-message";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

type ArtifactRow = ArtifactDetail & { id: string };

const MODE_TABS = ["all", "shadow", "promoted", "archived"] as const;

function ArtifactsPageInner() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const artifactId = urlState.artifactId;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [tab, setTab] = useState<(typeof MODE_TABS)[number]>("shadow");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [promoteWarn, setPromoteWarn] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<ArtifactRow | null>(null);
  const [nlAgent, setNlAgent] = useState("");
  const [nlText, setNlText] = useState("");

  const load = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.listArtifacts(currentOrg.id);
      if (res.status === "preview_disabled") {
        // Kill-switch / misconfig — not an opt-in wall. Soft-fail to empty + message.
        setError(
          (res.data as { message?: string } | undefined)?.message ??
            "Artifacts are disabled for this organization.",
        );
        setArtifacts([]);
        return;
      }
      setArtifacts(
        ((res.data?.artifacts as ArtifactRow[]) ?? []).map((a) => ({
          ...a,
          id: String(a.id),
        })),
      );
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load artifacts"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (tab === "all") return artifacts;
    return artifacts.filter((a) => (a.mode ?? "shadow") === tab);
  }, [artifacts, tab]);

  const selected = artifactId ? filtered.find((a) => a.id === artifactId) ?? artifacts.find((a) => a.id === artifactId) ?? null : null;
  const selectedIndex = artifactId ? filtered.findIndex((a) => a.id === artifactId) : -1;

  useListKeyboardNav(
    filtered.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    (idx) => {
      const row = filtered[idx];
      if (row) setUrlState({ artifactId: row.id });
    },
    !loading && filtered.length > 0,
  );

  const doPromote = async (a: ArtifactRow) => {
    if (!currentOrg || !a.id) return;
    const lowValue = (a.cost?.value_score ?? 1) < 0.05;
    if (lowValue && !promoteWarn) {
      setPromoteTarget(a);
      setPromoteWarn(true);
      return;
    }
    try {
      await learnApi.promoteArtifact(currentOrg.id, a.id);
      toast.success("Artifact promoted");
      setPromoteWarn(false);
      setPromoteTarget(null);
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Promotion failed"));
    }
  };

  const doArchive = async (ids: string[]) => {
    if (!currentOrg) return;
    try {
      for (const id of ids) {
        await learnApi.archiveArtifact(currentOrg.id, id);
      }
      toast.success(ids.length === 1 ? "Artifact archived" : `Archived ${ids.length} artifacts`);
      setSelectedIds([]);
      if (artifactId && ids.includes(artifactId)) setUrlState({ artifactId: undefined });
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Archive failed"));
    }
  };

  const doExport = async (agentId: string) => {
    if (!currentOrg) return;
    try {
      const res = await learnApi.exportArtifactsYaml(currentOrg.id, agentId);
      const yaml = (res.data as { yaml?: string })?.yaml ?? "";
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `artifacts-${agentId}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch (e) {
      toast.error(errorFromCaught(e, "Export failed"));
    }
  };

  const doAuthor = async () => {
    if (!currentOrg || !nlAgent || !nlText) return;
    try {
      await learnApi.authorArtifactNl(currentOrg.id, {
        agent_id: nlAgent,
        description: nlText,
      });
      toast.success("Shadow artifact drafted");
      setNlText("");
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, "Author failed"));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const kpi = {
    shadow: artifacts.filter((a) => a.mode === "shadow").length,
    promoted: artifacts.filter((a) => a.mode === "promoted").length,
    archived: artifacts.filter((a) => a.mode === "archived").length,
  };

  const tableBody = (
    <>
      <ResourceOsToolbar
        resourceKey="artifacts"
        exportRows={filtered.map((a) => ({
          id: a.id,
          name: a.name ?? "",
          mode: a.mode ?? "",
          agent_id: a.agent_id ?? "",
        }))}
        exportFilename="artifacts.csv"
        className="mb-4"
      />
      <div className="mb-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {[
          { label: "Shadow", value: kpi.shadow },
          { label: "Promoted", value: kpi.promoted },
          { label: "Archived 7d", value: kpi.archived },
        ].map((k) => (
          <Card key={k.label} className="p-3">
            <div className="text-lg font-semibold">{k.value}</div>
            <div className="text-xs text-[var(--text-muted)]">{k.label}</div>
          </Card>
        ))}
      </div>
      <Card className="mb-4 space-y-2 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <PenLine className="h-4 w-4" />
          Author from plain English
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="agent_id"
            value={nlAgent}
            onChange={(e) => setNlAgent(e.target.value)}
            aria-label="Agent ID for artifact author"
          />
          <Input
            className="min-w-[240px] flex-1"
            placeholder="Describe the fix…"
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            aria-label="Artifact description"
          />
          <Button size="sm" onClick={() => void doAuthor()}>
            <Sparkles className="mr-1 h-4 w-4" />
            Draft shadow
          </Button>
        </div>
      </Card>
      {error ? <ErrorState message={error} action={<Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>} /> : null}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof MODE_TABS)[number])}>
          <TabsList>
            {MODE_TABS.map((m) => (
              <TabsTrigger key={m} value={m} className="capitalize">
                {m}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={tab} className="mt-4">
            {filtered.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No artifacts yet"
                description={U20_EMPTY_COPY.artifacts}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button size="sm" asChild>
                      <Link href="/issues">View Agent Issues</Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/dashboard?onboarding=1">Connect agent</Link>
                    </Button>
                  </div>
                }
              />
            ) : (
              <div className="space-y-2">
                {filtered.map((a) => (
                  <Card
                    key={a.id}
                    className={cn(
                      "row-select-highlight p-4 transition-colors",
                      artifactId === a.id && "border-[var(--accent)] ring-1 ring-[var(--accent)]/30 is-selected",
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-1 gap-3">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selectedIds.includes(a.id)}
                          onChange={() => toggleSelect(a.id)}
                          aria-label={`Select ${a.name}`}
                        />
                        <div className="min-w-0">
                          <button
                            type="button"
                            className="text-left font-medium hover:underline"
                            onClick={() => setUrlState({ artifactId: a.id })}
                          >
                            {a.name}
                          </button>
                          <div className="text-xs text-[var(--text-muted)]">
                            {a.agent_id} · {a.mode}
                            {a.cost?.est_usd_per_month != null
                              ? ` · ~$${a.cost.est_usd_per_month}/mo`
                              : ""}
                            {a.cost?.value_score != null ? ` · value ${a.cost.value_score}` : ""}
                          </div>
                          {a.source_issue_id ? (
                            <Link
                              href={issueHref(a.source_issue_id)}
                              className="mt-1 inline-block text-xs text-[var(--accent)] hover:underline"
                            >
                              Source issue
                            </Link>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {a.agent_id ? (
                          <Button variant="outline" size="sm" onClick={() => void doExport(String(a.agent_id))}>
                            <Download className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {a.mode === "shadow" ? (
                          <Button size="sm" onClick={() => void doPromote(a)}>
                            Promote
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
      {promoteWarn && promoteTarget ? (
        <Card className="fixed bottom-20 right-6 z-50 max-w-md border-[var(--warning-strong)] p-4 shadow-lg">
          <p className="text-sm font-medium">Low value score</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            This Artifact may cost more in tokens than lift it provides. Promote only if you accept
            the tradeoff.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => void doPromote(promoteTarget)}>
              Promote anyway
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPromoteWarn(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
      <BulkActionBar
        count={selectedIds.length}
        onClear={() => setSelectedIds([])}
        actions={[
          {
            label: "Archive",
            variant: "destructive",
            onClick: () => void doArchive(selectedIds),
          },
          {
            label: "Export first agent",
            onClick: () => {
              const first = artifacts.find((a) => selectedIds.includes(a.id) && a.agent_id);
              if (first?.agent_id) void doExport(String(first.agent_id));
            },
          },
        ]}
      />
    </>
  );

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Artifacts"
          description="Production traces become Artifacts — versioned, evidence-gated runtime fixes."
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link href="/promotions">Promotions inbox</Link>
            </Button>
          }
        />
      }
      table={tableBody}
      detail={
        selected && currentOrg ? (
          <DetailPanelShell
            open
            onClose={() => setUrlState({ artifactId: undefined })}
            title={selected.name ?? "Artifact"}
            onPrev={
              selectedIndex > 0
                ? () => setUrlState({ artifactId: filtered[selectedIndex - 1]!.id })
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < filtered.length - 1
                ? () => setUrlState({ artifactId: filtered[selectedIndex + 1]!.id })
                : undefined
            }
            headerActions={
              selected.mode === "shadow" ? (
                <Button size="sm" onClick={() => void doPromote(selected)}>
                  Promote
                </Button>
              ) : null
            }
          >
            <ArtifactDetailPanel
              artifact={selected}
              orgId={currentOrg.id}
              showPromote={selected.mode === "shadow"}
              onPromote={() => void doPromote(selected)}
              onArchive={() => void doArchive([selected.id])}
            />
          </DetailPanelShell>
        ) : null
      }
    />
  );
}

export default function ArtifactsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      }
    >
      <ArtifactsPageInner />
    </Suspense>
  );
}
