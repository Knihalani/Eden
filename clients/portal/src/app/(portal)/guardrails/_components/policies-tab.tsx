"use client";

import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import {
  FEATURE_NOT_ENABLED_MESSAGE,
  FEATURE_NOT_ENABLED_TITLE,
  NOT_IMPLEMENTED_MESSAGE,
  NOT_IMPLEMENTED_TITLE,
} from "@/lib/feature-flag-error";
import { Shield, ShieldCheck, Plus, Zap, Loader2 } from "lucide-react";
import type { Policy } from "./types";
import { KIND_LABELS } from "./types";

export function PoliciesTab({
  policies,
  loading,
  error,
  onAddPolicy,
  onRefresh
}: {
  policies: Policy[];
  loading: boolean;
  error: string;
  onAddPolicy: () => void;
  onRefresh: () => void;
  orgId: string;
  onPolicyCreated: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
            Active policies
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Rules that gate every request and response at the gateway
          </p>
        </div>
        <div className="flex items-center gap-space-2">
          <Button onClick={onRefresh} disabled={loading} loading={loading} variant="ghost" className="min-h-11" aria-label="Refresh policies">
            <Zap className="w-3.5 h-3.5" aria-hidden />
            Refresh
          </Button>
          <Button onClick={onAddPolicy} className="min-h-11" aria-label="Add new policy">
            <Plus className="w-3.5 h-3.5" aria-hidden />
            Add policy
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState
          title={
            error === FEATURE_NOT_ENABLED_TITLE
              ? FEATURE_NOT_ENABLED_TITLE
              : error === NOT_IMPLEMENTED_TITLE
                ? NOT_IMPLEMENTED_TITLE
                : "Could not load policies"
          }
          message={
            error === FEATURE_NOT_ENABLED_TITLE
              ? FEATURE_NOT_ENABLED_MESSAGE
              : error === NOT_IMPLEMENTED_TITLE
                ? NOT_IMPLEMENTED_MESSAGE
                : error
          }
          action={
            error === FEATURE_NOT_ENABLED_TITLE || error === NOT_IMPLEMENTED_TITLE ? undefined : (
              <Button onClick={onRefresh} variant="outline" className="min-h-11">
                Try again
              </Button>
            )
          }
        />
      ) : loading && policies.length === 0 ? <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : policies.length === 0 ? (
          <EmptyState icon={Shield} title="No policies configured" description="Add a policy to start gating content at the gateway." size="lg" action={<Button className="min-h-11" onClick={onAddPolicy} aria-label="Add your first policy">
                <Plus className="w-4 h-4" aria-hidden />
                Add your first policy
              </Button>} />
        ) : (
          <DataTable columns={[{
        key: "name",
        header: "Name",
        sortable: true,
        sticky: true,
        cell: policy => {
          const kindMeta = KIND_LABELS[policy.kind] || KIND_LABELS.content;
          const KindIcon = kindMeta.icon;
          return <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center justify-center">
                        <KindIcon className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{policy.name}</p>
                        <p className="text-xs font-mono text-[var(--text-muted)]">{policy.policy_id.slice(0, 16)}</p>
                      </div>
                    </div>;
        }
      }, {
        key: "kind",
        header: "Kind",
        sortable: true,
        cell: policy => {
          const kindMeta = KIND_LABELS[policy.kind] || KIND_LABELS.content;
          return <span className={cn("inline-flex items-center gap-1 text-2xs uppercase tracking-wider font-semibold px-2 py-1 rounded-full", kindMeta.color)}>
                      {kindMeta.label}
                    </span>;
        }
      }, {
        key: "enabled",
        header: "Enabled",
        sortable: true,
        cell: policy => <div className="flex items-center gap-2">
                    <button aria-label={policy.enabled ? "Enabled" : "Disabled"} className={cn("relative inline-flex h-6 w-11 min-h-11 items-center rounded-full transition-colors", policy.enabled ? "bg-[var(--terminal)]" : "bg-[var(--bg-tertiary)]")}>
                      <span className={cn("inline-block h-4 w-4 transform rounded-full bg-[var(--bg-primary)] transition-transform", policy.enabled ? "translate-x-6" : "translate-x-1")} />
                    </button>
                    <span className="text-xs text-[var(--text-muted)]">{policy.enabled ? "On" : "Off"}</span>
                  </div>
      }, {
        key: "config",
        header: "Config",
        cell: policy => {
          const configJson = JSON.stringify(policy.config, null, 2);
          const configPreview = configJson.length > 80 ? configJson.slice(0, 80) + "…" : configJson;
          return <code className="text-2xs font-mono text-[var(--text-muted)] bg-[var(--bg-secondary)] px-2 py-1 rounded inline-block max-w-[280px] truncate align-middle" title={configJson}>
                      {configPreview}
                    </code>;
        }
      }]} rows={policies} rowKey={p => p.policy_id} defaultSort={{
        key: "name",
        direction: "asc"
      }} emptyTitle="No policies yet" emptyDescription="Add your first policy to enforce guardrails." emptyIcon={Shield} pageSize={25} />
        )}
    </div>;
}
