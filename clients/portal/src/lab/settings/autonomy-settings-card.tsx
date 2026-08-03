"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type AutonomyPolicy } from "@/lib/api/resources";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { SETTINGS_QUERY } from "@/lib/portal-query";
import { useLabToast } from "@/lab/lab-toast";
import { QueryErrorPanel } from "@/components/shell/query-error-panel";

/**
 * Runtime self-heal defaults ON (reversible actions). Settings is opt-out.
 */
export function AutonomySettingsCard({ canEdit = true }: { canEdit?: boolean }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const [saving, setSaving] = useState(false);

  const policyQuery = useOrgQuery(
    queryKeys.portal.autonomyPolicy(orgId),
    orgId,
    async () => (await api.getAutonomyPolicy(orgId!)).data,
    SETTINGS_QUERY,
  );

  const invalidate = useCallback(async () => {
    if (!orgId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.autonomyPolicy(orgId),
    });
  }, [orgId, queryClient]);

  const toggleSelfHeal = useCallback(
    async (policy: AutonomyPolicy) => {
      if (!orgId) return;
      const next = !policy.auto_runtime_heal;
      setSaving(true);
      try {
        await api.patchAutonomyPolicy(orgId, { auto_runtime_heal: next });
        await invalidate();
        pushToast({
          title: next ? "Runtime self-heal on" : "Runtime self-heal off",
          body: next
            ? `Reversible actions only · max ${policy.max_auto_rollbacks_per_day} rollbacks/day`
            : "Eden will recommend heals instead of executing them.",
          tone: next ? "ok" : "fail",
        });
      } catch (err) {
        pushToast({
          title: "Update failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      } finally {
        setSaving(false);
      }
    },
    [orgId, invalidate, pushToast],
  );

  if (policyQuery.isError) {
    return (
      <section id="autonomy-settings" className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
        <QueryErrorPanel
          title="Couldn’t load autonomy settings"
          error={policyQuery.error}
          onRetry={() => {
            void policyQuery.refetch();
          }}
        />
      </section>
    );
  }

  const policy = policyQuery.data;
  const mode = policy?.effective_mode ?? policy?.maintenance_mode ?? "assisted";
  const budget = policy?.budget ?? null;
  const healOn = Boolean(policy?.auto_runtime_heal);

  return (
    <section id="autonomy-settings" className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="type-label">Autonomy</p>
          <p className="type-meta mt-1">
            Maintenance mode <strong>{mode}</strong>
            {policy?.compliance_profile && policy.compliance_profile !== "standard" ? (
              <>
                <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                {policy.compliance_profile} profile
              </>
            ) : null}
            {budget ? (
              <>
                <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                ${budget.spent_usd.toFixed(2)} of ${budget.limit_usd.toFixed(2)}{" "}
                budget today
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <p className="type-label">Runtime self-heal (reversible actions only)</p>
        <button
          type="button"
          className="ds-tab mt-1.5"
          disabled={!canEdit || saving || !policy}
          aria-pressed={healOn}
          onClick={() => {
            if (policy) void toggleSelfHeal(policy);
          }}
        >
          {policyQuery.isLoading ? "Loading…" : healOn ? "On" : "Off"}
        </button>
        <p className="type-meta mt-1.5">
          On by default. Roll back a bad canary, reweight routing, or bust a
          cache without a human click — capped at{" "}
          {policy?.max_auto_rollbacks_per_day ?? 3} rollbacks/day. P0s still
          page you, with the mitigation already applied. Turn off to
          recommend-only.
        </p>
        {!healOn && (policy?.would_have_healed_count ?? 0) > 0 ? (
          <p className="type-meta mt-2 text-[var(--text)]">
            Eden would have fixed {policy!.would_have_healed_count} reversible
            heal{policy!.would_have_healed_count === 1 ? "" : "s"} in the last
            7 days while self-heal was off. Turn it back on to act next time.
          </p>
        ) : null}
        {healOn && budget && !budget.within_budget ? (
          <p className="type-meta mt-2 text-[var(--text)]">
            Maintenance budget exhausted — further heals pause until tomorrow
            or you raise the daily limit.
          </p>
        ) : null}
      </div>
    </section>
  );
}
