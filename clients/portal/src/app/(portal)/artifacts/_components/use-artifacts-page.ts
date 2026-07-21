"use client";

import { useMemo, useState } from "react";

import {
  deriveArtifactGate,
  type ArtifactDetail,
} from "@/components/artifacts/ArtifactDetailPanel";
import { useResourceUrlState } from "@/components/portal-os";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { learnApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { errorFromCaught } from "@/lib/safe-error-message";

export type ArtifactRow = ArtifactDetail & { id: string };

export const MODE_TABS = ["all", "shadow", "promoted", "archived"] as const;

export type ArtifactModeTab = (typeof MODE_TABS)[number];

export function useArtifactsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const artifactId = urlState.artifactId;
  const [tab, setTab] = useState<ArtifactModeTab>("shadow");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [promoteWarn, setPromoteWarn] = useState(false);
  const [promoteTarget, setPromoteTarget] = useState<ArtifactRow | null>(null);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [nlAgent, setNlAgent] = useState("");
  const [nlText, setNlText] = useState("");

  const artifactsQuery = useOrgQuery(
    queryKeys.artifacts.list(orgId),
    orgId,
    async () => {
      const res = await learnApi.listArtifacts(orgId!);
      if (res.status === "preview_disabled") {
        throw new Error(
          (res.data as { message?: string } | undefined)?.message ??
            "Artifacts are disabled for this organization.",
        );
      }
      return ((res.data?.artifacts as ArtifactRow[]) ?? []).map((a) => ({
        ...a,
        id: String(a.id),
      }));
    },
  );
  const artifacts = artifactsQuery.data ?? [];
  const loading = artifactsQuery.isLoading;
  const error = artifactsQuery.error?.message ?? null;

  const filtered = useMemo(() => {
    if (tab === "all") return artifacts;
    return artifacts.filter((a) => (a.mode ?? "shadow") === tab);
  }, [artifacts, tab]);

  const selected = artifactId
    ? (filtered.find((a) => a.id === artifactId) ??
      artifacts.find((a) => a.id === artifactId) ??
      null)
    : null;
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

  const runPromote = async (a: ArtifactRow) => {
    if (!currentOrg || !a.id) return;
    setPromoteBusy(true);
    try {
      const res = await learnApi.promoteArtifact(currentOrg.id, a.id);
      const report = res.data?.report as Record<string, unknown> | undefined;
      if (res.data?.promoted || report?.passed) {
        toast.success("Artifact promoted");
        setPromoteWarn(false);
        setPromoteTarget(null);
        await artifactsQuery.refetch();
      } else {
        const held = String(
          report?.explanation ||
            report?.recommendation ||
            report?.gate_verdict ||
            "hold",
        );
        toast.error(`Promotion held: ${held}`);
      }
    } catch (e) {
      toast.error(errorFromCaught(e, "Promotion failed"));
    } finally {
      setPromoteBusy(false);
    }
  };

  /** Hard boundary: list never promotes — detail evidence + CTA only. */
  const doPromote = async (a: ArtifactRow, { force = false } = {}) => {
    if (!currentOrg || !a.id) return;
    const gate = deriveArtifactGate({ evidence: a.evidence, cost: a.cost });
    if (gate.blocked && !force) return;
    if (gate.lowValue && !force && !promoteWarn) {
      setPromoteTarget(a);
      setPromoteWarn(true);
      return;
    }
    if (gate.verdict === "review" && !force && !promoteWarn) {
      setPromoteTarget(a);
      setPromoteWarn(true);
      return;
    }
    await runPromote(a);
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
      await artifactsQuery.refetch();
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
      await artifactsQuery.refetch();
    } catch (e) {
      toast.error(errorFromCaught(e, "Author failed"));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const artifactMode = (a: ArtifactRow) => a.mode ?? "shadow";
  const kpi = {
    shadow: artifacts.filter((a) => artifactMode(a) === "shadow").length,
    promoted: artifacts.filter((a) => artifactMode(a) === "promoted").length,
    archived: artifacts.filter((a) => artifactMode(a) === "archived").length,
  };
  const filterActive = tab !== "all";
  const filteredEmpty = !loading && !error && filtered.length === 0;

  return {
    currentOrg,
    artifactId,
    setUrlState,
    tab,
    setTab,
    selectedIds,
    setSelectedIds,
    promoteWarn,
    setPromoteWarn,
    promoteTarget,
    setPromoteTarget,
    promoteBusy,
    nlAgent,
    setNlAgent,
    nlText,
    setNlText,
    artifactsQuery,
    artifacts,
    loading,
    error,
    filtered,
    selected,
    selectedIndex,
    doPromote,
    doArchive,
    doExport,
    doAuthor,
    toggleSelect,
    artifactMode,
    kpi,
    filterActive,
    filteredEmpty,
  };
}
