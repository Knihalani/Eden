"use client";

import { useEffect, useState } from "react";
import { Loader2, Globe, MapPin, Lock, AlertTriangle, Check } from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const REGIONS: Array<{
  id: "us" | "eu" | "ap";
  label: string;
  description: string;
  blurb: string;
}> = [
  {
    id: "us",
    label: "United States",
    description: "us-east-1 / us-west-2",
    blurb: "Default region. Data resides in US-based infrastructure.",
  },
  {
    id: "eu",
    label: "European Union",
    description: "eu-west-1 / eu-central-1",
    blurb: "GDPR-aligned residency. Required for EU data subjects.",
  },
  {
    id: "ap",
    label: "Asia Pacific",
    description: "ap-southeast-1 / ap-northeast-1",
    blurb: "APAC residency for lower latency to Asian customers.",
  },
];

type RegionId = "us" | "eu" | "ap";

interface Region {
  org_id: string;
  region: RegionId;
  pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export function RegionTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const canEdit = hasPermission("settings:edit");

  const [region, setRegion] = useState<Region | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getRegion(currentOrg.id)
      .then((data) => {
        if (cancelled) return;
        setRegion(data);
        setDraft(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load region");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id]);

  const dirty = JSON.stringify(region) !== JSON.stringify(draft);

  const handleSave = async () => {
    if (!currentOrg || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateRegion(currentOrg.id, {
        region: draft.region,
        pinned: draft.pinned,
      });
      setRegion(updated);
      setDraft(updated);
      toast.success("Region updated");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update region";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => setDraft(region);

  if (!currentOrg) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage region.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
        <span className="ml-2 text-[var(--text-secondary)]">Loading region...</span>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="p-4 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg">
        <p className="text-sm text-[var(--text-secondary)]">
          {error ?? "No region available."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-[var(--bg-tertiary)] rounded-lg border border-[var(--border-default)]">
          <Globe className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Region &amp; data residency
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            Choose where this organization&apos;s data is stored at rest. Pinned regions cannot be
            auto-migrated by Eden.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" />
          <p className="text-sm text-red-500">{error}</p>
        </div>
      )}

      {!canEdit && (
        <div className="p-3 bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-muted)]">
          You do not have <code className="font-mono">settings:edit</code> permission. Region
          selection is read-only.
        </div>
      )}

      <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Storage region</h3>
        <div className="space-y-2" role="radiogroup" aria-label="Storage region">
          {REGIONS.map((r) => {
            const selected = draft.region === r.id;
            return (
              <label
                key={r.id}
                className={cn(
                  "flex items-start gap-3 p-3 border rounded-lg transition-colors",
                  selected
                    ? "border-[var(--accent)] bg-[var(--accent)]/5"
                    : "border-[var(--border-default)] bg-[var(--bg-tertiary)]",
                  !canEdit && "cursor-not-allowed"
                )}
              >
                <input
                  type="radio"
                  name="region"
                  value={r.id}
                  checked={selected}
                  disabled={!canEdit}
                  onChange={() => canEdit && setDraft({ ...draft, region: r.id })}
                  className="mt-1 text-[var(--accent)] focus:ring-[var(--accent)]"
                  aria-label={r.label}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-[var(--text-muted)]" />
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {r.label}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] font-mono">
                      ({r.id})
                    </span>
                    {selected && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-[var(--accent)]/20 text-[var(--accent)] rounded inline-flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        selected
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
                    {r.description}
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">{r.blurb}</p>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border-default)]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-[var(--text-muted)]" />
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Pin to selected region
              </h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Prevent Eden from ever migrating this organization&apos;s data to another region.
              Recommended for compliance-bound workloads.
            </p>
          </div>
          <button
            type="button"
            onClick={() => canEdit && setDraft({ ...draft, pinned: !draft.pinned })}
            disabled={!canEdit}
            aria-pressed={draft.pinned}
            aria-label="Toggle region pinning"
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors flex-shrink-0",
              draft.pinned ? "bg-[var(--accent)]" : "bg-[var(--bg-tertiary)]",
              !canEdit && "opacity-50 cursor-not-allowed"
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                draft.pinned && "translate-x-6"
              )}
            />
          </button>
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            className="px-4 py-2 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            Discard changes
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </div>
      )}

      {region?.updated_at && (
        <p className="text-xs text-[var(--text-muted)]">
          Last updated {new Date(region.updated_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}
