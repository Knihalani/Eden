"use client";

import { useCallback, useEffect, useState } from "react";
import { api, wave6Api } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

export interface VersionEntry {
  id: string;
  version: number;
  template: string;
  template_hash: string;
  model: string;
  params: Record<string, unknown>;
  variables: string[];
  change_note: string | null;
  created_by: string;
  created_at: string;
}

export function usePromptsVersions(orgId: string | undefined, selectedName: string | null) {
  const [versions, setVersions] = useState<Record<string, VersionEntry[]>>({});
  const [versionsLoading, setVersionsLoading] = useState<string | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [draftTemplate, setDraftTemplate] = useState("");
  const [draftModel, setDraftModel] = useState("gpt-4o");
  const [draftNote, setDraftNote] = useState("");
  const [versionDirty, setVersionDirty] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [envPinCount, setEnvPinCount] = useState(0);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);

  const resetVersionDraft = useCallback((seed?: VersionEntry | null) => {
    setDraftTemplate(seed?.template ?? "");
    setDraftModel(seed?.model ?? "gpt-4o");
    setDraftNote("");
    setVersionDirty(false);
  }, []);

  const fetchVersions = useCallback(
    async (name: string, opts?: { quiet?: boolean }) => {
      if (!orgId) return;
      if (!opts?.quiet) setVersionsLoading(name);
      setVersionsError(null);
      try {
        const d = await api.get<{ data: { versions: VersionEntry[] } }>(
          `/orgs/${orgId}/prompts/${encodeURIComponent(name)}`,
        );
        setVersions((prev) => ({ ...prev, [name]: d.data?.versions || [] }));
      } catch (err) {
        setVersionsError(errorFromCaught(err, "Failed to load prompt versions"));
      } finally {
        setVersionsLoading(null);
      }
    },
    [orgId],
  );

  useEffect(() => {
    if (!selectedName) return;
    if (!versions[selectedName]) void fetchVersions(selectedName);
  }, [selectedName, versions, fetchVersions]);

  useEffect(() => {
    if (!selectedName || versionDirty) return;
    const latest = versions[selectedName]?.[0];
    if (!latest) return;
    if (!draftTemplate) {
      setDraftTemplate(latest.template);
      setDraftModel(latest.model || "gpt-4o");
    }
  }, [selectedName, versions, versionDirty, draftTemplate]);

  useEffect(() => {
    if (!versionDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [versionDirty]);

  const saveVersion = useCallback(
    async (toast: {
      success: (t: string) => void;
      error: (t: string, d?: string) => void;
    }) => {
      if (!orgId || !selectedName) return;
      if (!draftTemplate.trim()) {
        toast.error("Template required", "Prompt template cannot be empty.");
        return;
      }
      if (!draftModel.trim()) {
        toast.error("Model required", "Model name cannot be empty.");
        return;
      }
      setSavingVersion(true);
      try {
        await api.post(`/orgs/${orgId}/prompts/${encodeURIComponent(selectedName)}/versions`, {
          template: draftTemplate,
          model: draftModel.trim(),
          params: {},
          variables: [],
          change_note: draftNote.trim() || null,
        });
        toast.success("Version published to registry");
        setVersionDirty(false);
        await fetchVersions(selectedName, { quiet: true });
      } catch (err) {
        toast.error("Save failed", errorFromCaught(err, "Please try again."));
      } finally {
        setSavingVersion(false);
      }
    },
    [orgId, selectedName, draftTemplate, draftModel, draftNote, fetchVersions],
  );

  const rollbackPin = useCallback(
    async (
      version: number,
      toast: { success: (t: string) => void; error: (t: string, d?: string) => void },
    ) => {
      if (!orgId || !selectedName) return;
      setRollbackBusy(true);
      try {
        await wave6Api.deployPrompt(orgId, selectedName, { env: "production", version });
        toast.success(`Rolled back production pin → v${version}`);
        setEnvPinCount((c) => Math.max(c, 1));
      } catch (err) {
        toast.error("Rollback failed", errorFromCaught(err, "Deploy pin failed."));
      } finally {
        setRollbackBusy(false);
      }
    },
    [orgId, selectedName],
  );

  const prepareSelect = useCallback(
    (name: string | null): boolean => {
      if (versionDirty) {
        const leave = window.confirm("You have an unsaved prompt version. Discard changes?");
        if (!leave) return false;
      }
      setVersionsError(null);
      setEnvPinCount(0);
      if (!name) {
        resetVersionDraft();
        return true;
      }
      resetVersionDraft(versions[name]?.[0] ?? null);
      if (!versions[name]) void fetchVersions(name);
      return true;
    },
    [versionDirty, versions, resetVersionDraft, fetchVersions],
  );

  return {
    versions,
    versionsLoading,
    versionsError,
    draftTemplate,
    draftModel,
    draftNote,
    versionDirty,
    savingVersion,
    envPinCount,
    rollbackBusy,
    expandedDiff,
    setDraftTemplate,
    setDraftModel,
    setDraftNote,
    setVersionDirty,
    setEnvPinCount,
    setExpandedDiff,
    fetchVersions,
    saveVersion,
    rollbackPin,
    prepareSelect,
  };
}
