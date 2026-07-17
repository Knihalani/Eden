"use client";

/**
 * Settings > Autonomous — toggle the Cat 14 destructive actions
 * (SelfHealer, auto-promote, etc.) and the Cat 1-23 intelligence
 * surface per-org. Defaults to ON (matches the Settings default
 * since June 2026). Only org admins can change.
 *
 * Also configures the recurring optimization schedule via the
 * Cat 23 code-change ``/policy`` API (default weekly).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bot,
  CalendarClock,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Wrench,
} from "lucide-react";
import { api, codeChangePolicyApi, improveRunsApi, type AutonomyPolicy, type CodeChangePolicy, type ImprovementSchedule, type OptimizationSchedule } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";

type Flags = {
  intelligence_gap_v0: boolean;
  autonomous_actions_v0: boolean;
};

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const SCHEDULE_OPTIONS: { value: OptimizationSchedule; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "monthly", label: "Monthly" },
];

const N23_CRON_PRESETS: { id: "daily" | "weekly" | "biweekly"; label: string; cron: string }[] = [
  { id: "daily", label: "Daily (03:00 UTC)", cron: "0 3 * * *" },
  { id: "weekly", label: "Weekly — Sunday 03:00 UTC", cron: "0 3 * * 0" },
  { id: "biweekly", label: "Biweekly — 1st & 15th 03:00 UTC", cron: "0 3 1,15 * *" },
];

function cronToPreset(cron: string): "daily" | "weekly" | "biweekly" | "custom" {
  const hit = N23_CRON_PRESETS.find((p) => p.cron === cron);
  return hit?.id ?? "custom";
}

const DEFAULT_N23_SCHEDULE: ImprovementSchedule = {
  improvement_schedule_cron: "0 3 * * 0",
  improvement_max_plans_per_sweep: 10,
};

const DEFAULT_SCHEDULE: CodeChangePolicy = {
  optimization_schedule: "weekly",
  optimization_weekday: 0,
  optimization_hour_utc: 9,
  optimization_day_of_month: 1,
  max_prs_per_run: 2,
};

export default function AutonomousTab() {
  const { currentOrg, refreshOrgs } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const [flags, setFlags] = useState<Flags>({
    intelligence_gap_v0: true,
    autonomous_actions_v0: true,
  });
  const [schedule, setSchedule] = useState<CodeChangePolicy>(DEFAULT_SCHEDULE);
  const [n23Schedule, setN23Schedule] = useState<ImprovementSchedule>(DEFAULT_N23_SCHEDULE);
  const [n23Preset, setN23Preset] = useState<"daily" | "weekly" | "biweekly" | "custom">("weekly");
  const [autoPrEnabled, setAutoPrEnabled] = useState(false);
  const [codeChangeEnabled, setCodeChangeEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [n23ScheduleLoaded, setN23ScheduleLoaded] = useState(false);
  const [n22Policy, setN22Policy] = useState<AutonomyPolicy | null>(null);
  const [n22Busy, setN22Busy] = useState(false);
  const [n22Loaded, setN22Loaded] = useState(false);

  // Seed from the org's current settings JSONB.
  useEffect(() => {
    if (!currentOrg) return;
    const s = currentOrg.settings ?? {};
    setFlags({
      intelligence_gap_v0: s.intelligence_gap_v0 !== false,
      autonomous_actions_v0: s.autonomous_actions_v0 !== false,
    });
    setLoaded(true);
  }, [currentOrg]);

  // N23 improvement agent schedule.
  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await improveRunsApi.getSchedule(currentOrg.id);
        const data = res?.data ?? DEFAULT_N23_SCHEDULE;
        if (!cancelled) {
          setN23Schedule({
            improvement_schedule_cron:
              data.improvement_schedule_cron ?? DEFAULT_N23_SCHEDULE.improvement_schedule_cron,
            improvement_max_plans_per_sweep:
              typeof data.improvement_max_plans_per_sweep === "number"
                ? data.improvement_max_plans_per_sweep
                : typeof data.max_plans_per_sweep === "number"
                  ? data.max_plans_per_sweep
                  : DEFAULT_N23_SCHEDULE.improvement_max_plans_per_sweep,
            next_run_at: data.next_run_at ?? null,
            last_run_at: data.last_run_at ?? null,
            last_sweep_plans_created: data.last_sweep_plans_created ?? null,
            last_sweep_llm_cost_usd: data.last_sweep_llm_cost_usd ?? null,
            schedule_enabled: data.schedule_enabled,
          });
          setN23Preset(cronToPreset(data.improvement_schedule_cron ?? ""));
          setN23ScheduleLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setN23Schedule(DEFAULT_N23_SCHEDULE);
          setN23ScheduleLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  // N22 autonomy policy bounds (maintenance mode + daily caps).
  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getAutonomyPolicy(currentOrg.id);
        if (!cancelled) {
          setN22Policy(res?.data ?? null);
          setN22Loaded(true);
        }
      } catch {
        if (!cancelled) {
          setN22Policy(null);
          setN22Loaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  // Load Cat 23 code-change policy (legacy schedule fields).
  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await codeChangePolicyApi.get(currentOrg.id);
        const policy = res?.data?.policy ?? {};
        if (!cancelled) {
          setSchedule({
            optimization_schedule:
              (policy.optimization_schedule as OptimizationSchedule) || "weekly",
            optimization_weekday:
              typeof policy.optimization_weekday === "number"
                ? policy.optimization_weekday
                : 0,
            optimization_hour_utc:
              typeof policy.optimization_hour_utc === "number"
                ? policy.optimization_hour_utc
                : 9,
            optimization_day_of_month:
              typeof policy.optimization_day_of_month === "number"
                ? policy.optimization_day_of_month
                : 1,
            max_prs_per_run:
              typeof policy.max_prs_per_run === "number"
                ? policy.max_prs_per_run
                : 2,
            last_optimization_run_at: policy.last_optimization_run_at ?? null,
          });
          setAutoPrEnabled(Boolean(policy.auto_pr_enabled));
          setCodeChangeEnabled(Boolean(policy.code_change_enabled));
          setScheduleLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setSchedule(DEFAULT_SCHEDULE);
          setScheduleLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  const isAdmin = hasPermission("settings:edit");

  async function persist(next: Flags) {
    if (!currentOrg) return;
    setBusy(true);
    try {
      await api.updateOrgSettings(currentOrg.id, next);
      setFlags(next);
      await refreshOrgs();
      toast.success(
        next.autonomous_actions_v0
          ? "Autonomous settings saved. SelfHealer + Inbox auto-suggest are ON."
          : "Autonomous settings saved. SelfHealer queue is paused. Inbox auto-suggest still runs.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function persistSchedule(next: CodeChangePolicy) {
    if (!currentOrg) return;
    setScheduleBusy(true);
    try {
      const res = await codeChangePolicyApi.update(currentOrg.id, {
        optimization_schedule: next.optimization_schedule,
        optimization_weekday: next.optimization_weekday,
        optimization_hour_utc: next.optimization_hour_utc,
        optimization_day_of_month: next.optimization_day_of_month,
        max_prs_per_run: next.max_prs_per_run,
      });
      if (res.status === "bad_request") {
        toast.error(res.message || "Invalid schedule settings");
        return;
      }
      const policy = res?.data?.policy ?? next;
      setSchedule((prev) => ({
        ...prev,
        optimization_schedule:
          (policy.optimization_schedule as OptimizationSchedule) ||
          next.optimization_schedule,
        optimization_weekday:
          typeof policy.optimization_weekday === "number"
            ? policy.optimization_weekday
            : next.optimization_weekday,
        optimization_hour_utc:
          typeof policy.optimization_hour_utc === "number"
            ? policy.optimization_hour_utc
            : next.optimization_hour_utc,
        optimization_day_of_month:
          typeof policy.optimization_day_of_month === "number"
            ? policy.optimization_day_of_month
            : next.optimization_day_of_month,
        max_prs_per_run:
          typeof policy.max_prs_per_run === "number"
            ? policy.max_prs_per_run
            : next.max_prs_per_run,
        last_optimization_run_at:
          policy.last_optimization_run_at ?? prev.last_optimization_run_at,
      }));
      toast.success("Optimization schedule saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function persistN23Schedule(next: ImprovementSchedule) {
    if (!currentOrg) return;
    setScheduleBusy(true);
    try {
      const res = await improveRunsApi.updateSchedule(currentOrg.id, {
        improvement_schedule_cron: next.improvement_schedule_cron,
        improvement_max_plans_per_sweep: next.improvement_max_plans_per_sweep,
      });
      const data = res?.data ?? next;
      setN23Schedule((prev) => ({
        ...prev,
        improvement_schedule_cron:
          data.improvement_schedule_cron ?? next.improvement_schedule_cron,
        improvement_max_plans_per_sweep:
          typeof data.improvement_max_plans_per_sweep === "number"
            ? data.improvement_max_plans_per_sweep
            : typeof data.max_plans_per_sweep === "number"
              ? data.max_plans_per_sweep
              : next.improvement_max_plans_per_sweep,
        next_run_at: data.next_run_at ?? prev.next_run_at,
        last_run_at: data.last_run_at ?? prev.last_run_at,
        last_sweep_plans_created:
          data.last_sweep_plans_created ?? prev.last_sweep_plans_created,
        last_sweep_llm_cost_usd:
          data.last_sweep_llm_cost_usd ?? prev.last_sweep_llm_cost_usd,
      }));
      toast.success("Improvement sweep schedule saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleBusy(false);
    }
  }

  async function persistN22(patch: Partial<AutonomyPolicy>) {
    if (!currentOrg || !isAdmin) return;
    setN22Busy(true);
    try {
      const res = await api.patchAutonomyPolicy(currentOrg.id, patch);
      setN22Policy(res?.data ?? null);
      toast.success("Autonomy policy updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setN22Busy(false);
    }
  }

  async function persistAutoPr(next: boolean) {
    if (!currentOrg) return;
    setScheduleBusy(true);
    try {
      const res = await codeChangePolicyApi.update(currentOrg.id, {
        auto_pr_enabled: next,
        code_change_enabled: next ? true : codeChangeEnabled,
      });
      const policy = res?.data?.policy ?? {};
      setAutoPrEnabled(Boolean(policy.auto_pr_enabled ?? next));
      setCodeChangeEnabled(Boolean(policy.code_change_enabled ?? codeChangeEnabled));
      toast.success(
        next
          ? "Auto-PR enabled — approved patches can open PRs without manual click."
          : "Auto-PR disabled — patches stay in inbox until you open a PR.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleBusy(false);
    }
  }

  if (!currentOrg) return null;

  const sched = schedule.optimization_schedule || "weekly";
  const showWeekday = sched === "weekly" || sched === "biweekly";
  const showMonthDay = sched === "monthly";
  const scheduleDisabled = !isAdmin || scheduleBusy || sched === "off";

  return (
    <div className="space-y-6">
      <IntegrationStatusBanners integration="github" orgId={currentOrg.id} />

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 p-5 flex items-start gap-4">
        <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
          <Bot className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Autonomous features</h2>
          <p className="text-sm text-[var(--text-secondary)] mt-1 leading-relaxed">
            Eden ships with two flags enabled by default. The
            <span className="text-[var(--text-primary)] font-medium">
              {" "}Inbox{" "}
            </span>
            proposes unified-diff patches for failing traces and
            <span className="text-[var(--text-primary)] font-medium">
              {" "}SelfHealer{" "}
            </span>
            queues canary rollbacks, cache busts, and model
            reweights. Both routes require a human approval
            before any code is changed or model is swapped.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Autonomy tiers (T0–T4)</h3>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
          Eden grades autonomous actions from observe-only to auto-merge. Your effective tier is the
          lowest level allowed by maintenance mode, compliance profile, and daily budget.
        </p>
        <ul className="text-sm text-[var(--text-secondary)] space-y-2 list-disc pl-5">
          <li><strong className="text-[var(--text-primary)]">T0 — Observe:</strong> Detect issues and recommend fixes only. No runtime changes.</li>
          <li><strong className="text-[var(--text-primary)]">T1 — Diagnose:</strong> Auto-triage and investigate. Still no mutations.</li>
          <li><strong className="text-[var(--text-primary)]">T2 — Assisted heal:</strong> Runtime heals (rollback, cache bust, reweight) may auto-run; code patches need approval.</li>
          <li><strong className="text-[var(--text-primary)]">T3 — Promote:</strong> Evidence-gated prompt canaries and nudge promotions when policy allows.</li>
          <li><strong className="text-[var(--text-primary)]">T4 — Auto-merge:</strong> Highest blast radius — auto-merge approved patches (off by default).</li>
        </ul>
        <p className="text-xs text-[var(--text-muted)]">
          HIPAA compliance profile forces T0 (observe only). Edit bounds below;
          kill switches for rollback / reweight / cache_bust live under Settings → FinOps.
        </p>
      </div>

      {n22Loaded && n22Policy && (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 p-4 space-y-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
              <ShieldAlert className="w-5 h-5 text-[var(--accent)]" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Maintenance bounds (N22)
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
                Effective mode:{" "}
                <span className="font-medium text-[var(--text-primary)]">
                  {n22Policy.effective_mode ?? n22Policy.maintenance_mode}
                </span>
                {n22Policy.budget && (
                  <>
                    {" · "}
                    Budget ${n22Policy.budget.spent_usd.toFixed(2)} / $
                    {n22Policy.budget.limit_usd.toFixed(2)}
                    {!n22Policy.budget.within_budget && (
                      <span className="text-[var(--error)]"> (exhausted)</span>
                    )}
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">Maintenance mode</span>
              <select
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={n22Policy.maintenance_mode}
                disabled={!isAdmin || n22Busy}
                onChange={(e) => {
                  const maintenance_mode = e.target.value as AutonomyPolicy["maintenance_mode"];
                  setN22Policy((p) => (p ? { ...p, maintenance_mode } : p));
                  void persistN22({ maintenance_mode });
                }}
              >
                <option value="observe">Observe — detect + recommend only</option>
                <option value="assisted">Assisted — auto runtime heal; patches need approve</option>
                <option value="autonomous">Autonomous — heal + open PRs per bounds</option>
              </select>
            </label>

            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">Compliance profile</span>
              <select
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={n22Policy.compliance_profile}
                disabled={!isAdmin || n22Busy}
                onChange={(e) => {
                  const compliance_profile = e.target
                    .value as AutonomyPolicy["compliance_profile"];
                  setN22Policy((p) => (p ? { ...p, compliance_profile } : p));
                  void persistN22({ compliance_profile });
                }}
              >
                <option value="standard">Standard</option>
                <option value="soc2_strict">SOC2 strict (no auto-merge)</option>
                <option value="hipaa">HIPAA (observe only)</option>
              </select>
            </label>

            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">
                Daily maintenance budget (USD)
              </span>
              <input
                type="number"
                min={0}
                step={1}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={n22Policy.daily_maintenance_budget_usd}
                disabled={!isAdmin || n22Busy}
                onBlur={(e) => {
                  const daily_maintenance_budget_usd = Number(e.target.value);
                  if (Number.isFinite(daily_maintenance_budget_usd)) {
                    void persistN22({ daily_maintenance_budget_usd });
                  }
                }}
                onChange={(e) => {
                  const daily_maintenance_budget_usd = Number(e.target.value);
                  setN22Policy((p) =>
                    p ? { ...p, daily_maintenance_budget_usd } : p,
                  );
                }}
              />
            </label>

            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">
                Max auto-rollbacks / day
              </span>
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={n22Policy.max_auto_rollbacks_per_day}
                disabled={!isAdmin || n22Busy}
                onBlur={(e) => {
                  const max_auto_rollbacks_per_day = Number(e.target.value);
                  if (Number.isFinite(max_auto_rollbacks_per_day)) {
                    void persistN22({ max_auto_rollbacks_per_day });
                  }
                }}
                onChange={(e) => {
                  const max_auto_rollbacks_per_day = Number(e.target.value);
                  setN22Policy((p) =>
                    p ? { ...p, max_auto_rollbacks_per_day } : p,
                  );
                }}
              />
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["auto_runtime_heal", "Auto runtime heal (rollback / reweight / cache bust)"],
                ["auto_code_patch_pr", "Auto open code-patch PRs"],
                ["auto_code_patch_merge", "Auto-merge patches (sandbox only)"],
                ["auto_prompt_canary", "Auto prompt canaries"],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"
              >
                <input
                  type="checkbox"
                  checked={Boolean(n22Policy[key])}
                  disabled={!isAdmin || n22Busy}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setN22Policy((p) => (p ? { ...p, [key]: next } : p));
                    void persistN22({ [key]: next });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}

      <FlagRow
        title="Intelligence surface (Cat 1-23)"
        description="Routes under /intelligence/*. Includes the Inbox, Knowledge Graph, Patch Generator, and Style Learner. Turning this off hides the surface entirely."
        icon={Wrench}
        enabled={flags.intelligence_gap_v0}
        disabled={!isAdmin || busy}
        onChange={(v) => persist({ ...flags, intelligence_gap_v0: v })}
      />

      <FlagRow
        title="Autonomous destructive actions (Cat 14)"
        description="Required for /heal + /heal/{id}/approve + /heal/{id}/deny. Every action still waits for an admin's explicit approval before any state changes."
        icon={flags.autonomous_actions_v0 ? ShieldCheck : ShieldOff}
        enabled={flags.autonomous_actions_v0}
        disabled={!isAdmin || busy || !flags.intelligence_gap_v0}
        warn={flags.autonomous_actions_v0}
        onChange={(v) => persist({ ...flags, autonomous_actions_v0: v })}
      />

      <FlagRow
        title="Auto-open PRs (N20)"
        description="When enabled, approved issue patches can automatically open GitHub PRs (requires code-change + GitHub App). Off by default for safety."
        icon={autoPrEnabled ? ShieldCheck : ShieldOff}
        enabled={autoPrEnabled}
        disabled={!isAdmin || scheduleBusy || !flags.intelligence_gap_v0}
        warn={autoPrEnabled}
        onChange={(v) => void persistAutoPr(v)}
      />

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 p-4 space-y-4">
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
            <CalendarClock className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Recurring improvement agent (N23)</div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
              Per-org cron sweeps production signals and lands ranked plans in{" "}
              <Link href="/improve/plans" className="text-[var(--accent)] hover:underline">
                Improvement plans
              </Link>
              . Approve always opens a GitHub PR.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs space-y-1">
            <span className="text-[var(--text-secondary)]">Sweep cadence</span>
            <select
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
              value={n23Preset === "custom" ? "weekly" : n23Preset}
              disabled={!isAdmin || scheduleBusy}
              onChange={(e) => {
                const preset = e.target.value as "daily" | "weekly" | "biweekly";
                const match = N23_CRON_PRESETS.find((p) => p.id === preset);
                if (!match) return;
                setN23Preset(preset);
                const next = {
                  ...n23Schedule,
                  improvement_schedule_cron: match.cron,
                };
                setN23Schedule(next);
                void persistN23Schedule(next);
              }}
            >
              {N23_CRON_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs space-y-1 sm:col-span-2">
            <span className="text-[var(--text-secondary)]">
              Max plans per sweep: {n23Schedule.improvement_max_plans_per_sweep}
            </span>
            <input
              type="range"
              min={1}
              max={25}
              step={1}
              value={n23Schedule.improvement_max_plans_per_sweep}
              disabled={!isAdmin || scheduleBusy}
              onChange={(e) => {
                setN23Schedule((prev) => ({
                  ...prev,
                  improvement_max_plans_per_sweep: Number(e.target.value),
                }));
              }}
              onMouseUp={(e) => {
                const val = Number((e.target as HTMLInputElement).value);
                void persistN23Schedule({
                  ...n23Schedule,
                  improvement_max_plans_per_sweep: val,
                });
              }}
              onTouchEnd={(e) => {
                const val = Number((e.target as HTMLInputElement).value);
                void persistN23Schedule({
                  ...n23Schedule,
                  improvement_max_plans_per_sweep: val,
                });
              }}
              className="w-full"
              aria-label="Max plans per sweep"
            />
          </label>
        </div>

        {n23ScheduleLoaded && (
          <div className="text-[11px] text-[var(--text-muted)] space-y-1">
            {n23Schedule.last_run_at && (
              <p>Last sweep: {new Date(n23Schedule.last_run_at).toLocaleString()}</p>
            )}
            {n23Schedule.last_sweep_plans_created != null && (
              <p>Plans created (last sweep): {n23Schedule.last_sweep_plans_created}</p>
            )}
            {n23Schedule.last_sweep_llm_cost_usd != null && (
              <p>LLM cost (last sweep): ${n23Schedule.last_sweep_llm_cost_usd.toFixed(4)}</p>
            )}
            {n23Schedule.next_run_at && (
              <p>Next run: {new Date(n23Schedule.next_run_at).toLocaleString()}</p>
            )}
            <p className="font-mono text-[10px] opacity-70">
              cron: {n23Schedule.improvement_schedule_cron}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]/30 p-4 space-y-4 opacity-80">
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-[var(--accent-faint)] p-2 shrink-0">
            <CalendarClock className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Legacy optimization schedule (Cat 23)</div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
              Deprecated — superseded by N23 above. Kept for orgs still on code-change policy.
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs space-y-1">
            <span className="text-[var(--text-secondary)]">Cadence</span>
            <select
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
              value={sched}
              disabled={!isAdmin || scheduleBusy}
              onChange={(e) => {
                const next = {
                  ...schedule,
                  optimization_schedule: e.target.value as OptimizationSchedule,
                };
                setSchedule(next);
                void persistSchedule(next);
              }}
            >
              {SCHEDULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs space-y-1">
            <span className="text-[var(--text-secondary)]">Hour (UTC)</span>
            <select
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
              value={schedule.optimization_hour_utc ?? 9}
              disabled={scheduleDisabled}
              onChange={(e) => {
                const next = {
                  ...schedule,
                  optimization_hour_utc: Number(e.target.value),
                };
                setSchedule(next);
                void persistSchedule(next);
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00 UTC
                </option>
              ))}
            </select>
          </label>

          {showWeekday && (
            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">Weekday</span>
              <select
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={schedule.optimization_weekday ?? 0}
                disabled={scheduleDisabled}
                onChange={(e) => {
                  const next = {
                    ...schedule,
                    optimization_weekday: Number(e.target.value),
                  };
                  setSchedule(next);
                  void persistSchedule(next);
                }}
              >
                {WEEKDAYS.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {showMonthDay && (
            <label className="block text-xs space-y-1">
              <span className="text-[var(--text-secondary)]">Day of month</span>
              <select
                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
                value={schedule.optimization_day_of_month ?? 1}
                disabled={scheduleDisabled}
                onChange={(e) => {
                  const next = {
                    ...schedule,
                    optimization_day_of_month: Number(e.target.value),
                  };
                  setSchedule(next);
                  void persistSchedule(next);
                }}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block text-xs space-y-1">
            <span className="text-[var(--text-secondary)]">Max PRs per run</span>
            <select
              className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm"
              value={schedule.max_prs_per_run ?? 2}
              disabled={scheduleDisabled}
              onChange={(e) => {
                const next = {
                  ...schedule,
                  max_prs_per_run: Number(e.target.value),
                };
                setSchedule(next);
                void persistSchedule(next);
              }}
            >
              {[1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        {scheduleLoaded && schedule.last_optimization_run_at && (
          <p className="text-[11px] text-[var(--text-muted)]">
            Last run: {schedule.last_optimization_run_at}
          </p>
        )}
        {scheduleBusy && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            Saving schedule…
          </div>
        )}
      </div>

      {!isAdmin && (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-4 flex items-start gap-3 text-sm text-[var(--text-secondary)]">
          <ShieldAlert className="w-4 h-4 mt-0.5 text-[var(--text-muted)] shrink-0" />
          <div>
            Only org admins can change these flags. Ask an admin in
            your workspace if you need them flipped.
          </div>
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="w-3 h-3 animate-spin" />
          Saving…
        </div>
      )}

      {loaded && (
        <p className="text-xs text-[var(--text-muted)]">
          Persisted to <code>organizations.features</code> in the
          backend; the corresponding env vars
          (<code>INTELLIGENCE_GAP_V0</code>,{" "}
          <code>AUTONOMOUS_ACTIONS_V0</code>) override per-deployment.
          Schedule lives in <code>code_change_policy</code>.
        </p>
      )}
    </div>
  );
}

function FlagRow({
  title,
  description,
  icon: Icon,
  enabled,
  disabled,
  warn,
  onChange,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  enabled: boolean;
  disabled?: boolean;
  warn?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`rounded-xl border p-4 flex items-start gap-4 ${
        warn && enabled
          ? "border-[var(--warning)]/30 bg-[var(--warning-bg)]"
          : "border-[var(--border-default)] bg-[var(--bg-secondary)]/30"
      }`}
    >
      <div
        className={`rounded-lg p-2 shrink-0 ${
          enabled ? "bg-[var(--success-bg)]" : "bg-[var(--bg-base)]"
        }`}
      >
        <Icon
          className={`w-5 h-5 ${
            enabled ? "text-emerald-400" : "text-[var(--text-muted)]"
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{title}</div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
              {description}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked)}
              className="sr-only peer"
            />
            <span
              className={`w-10 h-5 rounded-full transition-colors ${
                enabled
                  ? warn
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--success)]"
                  : "bg-[var(--bg-base)]"
              } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            />
            <span
              className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-5" : ""
              }`}
            />
          </label>
        </div>
        {warn && enabled && (
          <p className="text-[11px] text-[var(--warning)]/80 mt-2">
            Active. Every destructive action still requires an admin&apos;s
            explicit approval via the Inbox or the heal queue.
          </p>
        )}
      </div>
    </div>
  );
}
