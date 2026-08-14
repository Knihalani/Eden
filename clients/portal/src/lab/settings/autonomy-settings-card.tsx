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
import { cn } from "@/lib/utils";

const MODES = [
  {
    value: "observe",
    label: "Observe",
    body: "Eden recommends; nothing auto-executes.",
  },
  {
    value: "assisted",
    label: "Assisted",
    body: "Reversible heals auto-execute; code changes need review.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    body: "Auto-executes within the daily budget and compliance caps.",
  },
] as const;

const COMPLIANCE_PROFILES = [
  { value: "standard", label: "Standard" },
  { value: "hipaa", label: "HIPAA" },
  { value: "soc2_strict", label: "SOC2 strict" },
] as const;

function modeLabel(mode: string): string {
  const known = MODES.find((m) => m.value === mode)?.label;
  if (known) return known;
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

/**
 * Wave 5 (5.2) — full N22 autonomy surface. The old card exposed only
 * the self-heal toggle + budget readout (F-G gap). Now: maintenance-mode
 * selector (observe/assisted/autonomous), compliance profile, editable
 * daily budget, and per-agent policy rows — all backed by
 * ``/settings/autonomy`` (GET/PATCH + the new ``/agents`` list).
 */
export function AutonomySettingsCard({ canEdit = true }: { canEdit?: boolean }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { pushToast } = useLabToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string>("");

  const policyQuery = useOrgQuery(
    queryKeys.portal.autonomyPolicy(orgId),
    orgId,
    async () => (await api.getAutonomyPolicy(orgId!)).data,
    SETTINGS_QUERY,
  );

  const agentsQuery = useOrgQuery(
    queryKeys.portal.autonomyAgents(orgId),
    orgId,
    async () => (await api.getAutonomyAgents(orgId!)).data,
    SETTINGS_QUERY,
  );

  const earningsQuery = useOrgQuery(
    queryKeys.portal.autonomyEarnings(orgId),
    orgId,
    async () => (await api.getAutonomyEarnings(orgId!)).data,
    SETTINGS_QUERY,
  );

  const invalidate = useCallback(async () => {
    if (!orgId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.autonomyPolicy(orgId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.autonomyAgents(orgId),
    });
    await queryClient.invalidateQueries({
      queryKey: queryKeys.portal.autonomyEarnings(orgId),
    });
  }, [orgId, queryClient]);

  const patch = useCallback(
    async (
      key: string,
      body: Parameters<typeof api.patchAutonomyPolicy>[1],
      agentId?: string | null,
      opts?: { okTitle?: string; okBody?: string },
    ) => {
      if (!orgId) return;
      setSaving(key);
      try {
        await api.patchAutonomyPolicy(orgId, body, agentId ?? undefined);
        await invalidate();
        pushToast({
          title: opts?.okTitle ?? "Autonomy settings updated",
          body: opts?.okBody,
          tone: "ok",
        });
      } catch (err) {
        pushToast({
          title: "Update failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      } finally {
        setSaving(null);
      }
    },
    [orgId, invalidate, pushToast],
  );

  const toggleSelfHeal = useCallback(
    async (policy: AutonomyPolicy, agentId?: string | null) => {
      const next = !policy.auto_runtime_heal;
      await patch(
        agentId ? `heal:${agentId}` : "heal",
        { auto_runtime_heal: next },
        agentId,
        {
          okTitle: next ? "Runtime self-heal on" : "Runtime self-heal off",
          okBody: next
            ? `Reversible actions only · max ${policy.max_auto_rollbacks_per_day} rollbacks/day`
            : "Eden will recommend heals instead of executing them.",
        },
      );
    },
    [patch],
  );

  const toggleEarnedAutonomy = useCallback(async (p: AutonomyPolicy) => {
    const next = !p.earned_autonomy_enabled;
    await patch("earned", { earned_autonomy_enabled: next }, undefined, {
      okTitle: next ? "Earned autonomy program on" : "Earned autonomy program off",
      okBody: next
        ? "When the clean-merge streak hits the threshold, auto-merge (T4) unlocks automatically."
        : "Auto-merge stays off even if the clean-merge streak clears.",
    });
  }, [patch]);

  const saveBudget = useCallback(async () => {
    const value = Number.parseFloat(budgetDraft);
    if (!Number.isFinite(value) || value < 0) {
      pushToast({
        title: "Invalid budget",
        body: "Enter a positive USD amount.",
        tone: "fail",
      });
      return;
    }
    await patch("budget", { daily_maintenance_budget_usd: value }, undefined, {
      okTitle: "Daily budget updated",
      okBody: `Eden will cap maintenance at $${value.toFixed(2)}/day.`,
    });
  }, [budgetDraft, patch, pushToast]);

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
  const mode = policy?.effective_mode ?? policy?.maintenance_mode ?? "observe";
  const compliance = policy?.compliance_profile ?? "standard";
  const budget = policy?.budget ?? null;
  const healOn = Boolean(policy?.auto_runtime_heal);
  const budgetDraftValue =
    budgetDraft ||
    (policy?.daily_maintenance_budget_usd != null
      ? String(policy.daily_maintenance_budget_usd)
      : "");
  const agents = agentsQuery.data?.agents ?? [];
  const earnings = earningsQuery.data;
  const earnedOn = Boolean(policy?.earned_autonomy_enabled);

  return (
    <section id="autonomy-settings" className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="type-label">Autonomy</p>
          <p className="type-meta mt-1">
            Maintenance mode <strong>{modeLabel(mode)}</strong>
            {compliance !== "standard" ? (
              <>
                <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                {compliance} profile
              </>
            ) : null}
            {budget ? (
              <>
                <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                ${budget.spent_usd.toFixed(2)} of ${budget.limit_usd.toFixed(2)}{" "}
                autonomy daily cap
              </>
            ) : null}
          </p>
        </div>
      </div>

      {/* Maintenance mode */}
      <div className="mt-5">
        <p className="type-label">Maintenance mode</p>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              className={cn(
                "ds-tab flex-col items-start !h-auto !min-h-0 gap-0.5 py-2 text-left",
                mode === m.value && "text-[var(--text)]",
              )}
              disabled={!canEdit || saving !== null}
              aria-pressed={mode === m.value}
              onClick={() => {
                if (mode !== m.value) {
                  void patch(
                    `mode:${m.value}`,
                    { maintenance_mode: m.value },
                    undefined,
                    { okTitle: `Mode: ${m.label}` },
                  );
                }
              }}
            >
              <span className="type-ui">{m.label}</span>
              <span className="type-meta">{m.body}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Compliance profile */}
      <div className="mt-5">
        <p className="type-label">Compliance profile</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {COMPLIANCE_PROFILES.map((p) => (
            <button
              key={p.value}
              type="button"
              className={cn(
                "ds-tab",
                compliance === p.value && "text-[var(--text)]",
              )}
              disabled={!canEdit || saving !== null}
              aria-pressed={compliance === p.value}
              onClick={() => {
                if (compliance !== p.value) {
                  void patch(`compliance:${p.value}`, {
                    compliance_profile: p.value,
                  });
                }
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="type-meta mt-1.5">
          Compliance is a hard override applied regardless of the mode
          above: <strong>HIPAA</strong> forces <strong>observe</strong> and{" "}
          <strong>SOC2 strict</strong> forbids auto-merge.
        </p>
      </div>

      {/* Daily budget */}
      <div className="mt-5">
        <p className="type-label">Daily maintenance budget</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <input
            type="number"
            min={0}
            step={1}
            value={budgetDraftValue}
            disabled={!canEdit || saving !== null}
            onChange={(e) => setBudgetDraft(e.target.value)}
            aria-label="Daily maintenance budget USD"
            className="ds-input !w-36"
          />
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={!canEdit || saving !== null}
            onClick={() => void saveBudget()}
          >
            Save
          </button>
        </div>
        <p className="type-meta mt-1.5">
          Covers heals, canary promote/rollback, and patch generation.
          {budget && !budget.within_budget ? (
            <span className="ml-1 text-[var(--text)]">
              Currently exhausted — raise the limit or wait until tomorrow.
            </span>
          ) : null}
        </p>
      </div>

      {/* Per-agent overrides */}
      <div className="mt-5">
        <p className="type-label">Per-agent overrides</p>
        <p className="type-meta mt-1">
          Rows below are agents with their own policy override; all other
          agents inherit the org defaults above.
        </p>
        {agents.length === 0 ? (
          <p className="type-meta mt-2 text-[var(--text-faint)]">
            No per-agent overrides yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {agents.map((agent) => {
              const agentMode = agent.effective_mode ?? agent.maintenance_mode;
              return (
                <li
                  key={agent.agent_id}
                  className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2 first:border-t-0 first:pt-0"
                >
                  <span className="type-ui">{agent.agent_id}</span>
                  <select
                    aria-label={`Mode for ${agent.agent_id}`}
                    value={agentMode}
                    disabled={!canEdit || saving !== null}
                    onChange={(e) =>
                      void patch(
                        `agentmode:${agent.agent_id}`,
                        {
                          maintenance_mode: e.target
                            .value as AutonomyPolicy["maintenance_mode"],
                        },
                        agent.agent_id ?? undefined,
                        {
                          okTitle: `Mode for ${agent.agent_id} updated`,
                          okBody: modeLabel(e.target.value),
                        },
                      )
                    }
                    className="ds-input !h-8 !w-40"
                  >
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ds-tab"
                    disabled={!canEdit || saving !== null}
                    aria-pressed={agent.auto_runtime_heal}
                    onClick={() => void toggleSelfHeal(agent, agent.agent_id)}
                  >
                    self-heal {agent.auto_runtime_heal ? "on" : "off"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Earned autonomy (Wave 6) */}
      <div className="mt-5">
        <p className="type-label">Earned autonomy</p>
        <p className="type-meta mt-1">
          Opt in and Eden grants <strong>T4 auto-merge</strong> automatically
          once the org proves {earnings?.threshold ?? 5} consecutive clean
          auto-merges — the post-merge watch on every merged PR (1h/24h/7d)
          must close without a regression.
        </p>

        <div className="mt-3 rounded-md border border-[var(--line)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="type-ui">
              {earnings?.streak ?? 0} of {earnings?.threshold ?? 5}{" "}
              clean auto-merges
            </span>
            {earnings?.earned ? (
              <span className="type-ui text-[var(--text)]">T4 earned</span>
            ) : (
              <span className="type-meta text-[var(--text-faint)]">
                {earnings?.in_flight
                  ? `${earnings.in_flight} in flight`
                  : earnings
                    ? "no merges judged yet"
                    : "…"}
              </span>
            )}
          </div>

          {earnings?.earned ? (
            <p className="type-meta mt-2">
              {earnings.policy.auto_code_patch_merge ? (
                <strong>Auto-merge is on.</strong>
              ) : earnedOn ? (
                <>Streak cleared — auto-merge is unlocking.</>
              ) : (
                <>Streak cleared — turn the program on to unlock auto-merge.</>
              )}{" "}
              A degrading watch resets the streak and re-locks the tier.
            </p>
          ) : null}

          <button
            type="button"
            className="ds-tab mt-3"
            disabled={!canEdit || saving !== null || !policy}
            aria-pressed={earnedOn}
            onClick={() => {
              if (policy) void toggleEarnedAutonomy(policy);
            }}
          >
            {policyQuery.isLoading
              ? "Loading…"
              : earnedOn
                ? "Program on"
                : "Program off"}
          </button>
        </div>

        {earnings && earnings.recent.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {earnings.recent.slice(0, 4).map((plan) => (
              <li
                key={plan.plan_id}
                className="type-meta flex items-center justify-between gap-2 border-t border-[var(--line)] pt-1 first:border-t-0"
              >
                <span className="min-w-0 truncate">
                  {plan.title ?? plan.plan_id.slice(0, 8)}
                  {plan.manual ? " · manual merge" : ""}
                </span>
                <span className="shrink-0">
                  {plan.status === "clean"
                    ? "clean"
                    : plan.status === "in_flight"
                      ? "watching…"
                      : plan.status === "unproven"
                        ? "unproven"
                        : "regressed"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-5">
        <p className="type-label">Runtime self-heal (reversible actions only)</p>
        <button
          type="button"
          className="ds-tab mt-1.5"
          disabled={!canEdit || saving !== null || !policy}
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
          {policy?.max_auto_rollbacks_per_day ?? 3} rollbacks/day. Critical
          issues still need human review — Eden does not page for P0 security
          events. Turn off to recommend-only.
        </p>
        {!healOn && (policy?.would_have_healed_count ?? 0) > 0 ? (
          <p className="type-meta mt-2 text-[var(--text)]">
            Eden would have fixed {policy!.would_have_healed_count} reversible
            heal{policy!.would_have_healed_count === 1 ? "" : "s"} in the last
            7 days while self-heal was off. Turn it back on to act next time.
          </p>
        ) : null}
      </div>
    </section>
  );
}
