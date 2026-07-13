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
import {
  Bot,
  CalendarClock,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Wrench,
} from "lucide-react";
import { api, codeChangePolicyApi, type CodeChangePolicy, type OptimizationSchedule } from "@/lib/api";
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
  const [autoPrEnabled, setAutoPrEnabled] = useState(false);
  const [codeChangeEnabled, setCodeChangeEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

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

  // Load Cat 23 code-change policy (schedule fields).
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
          HIPAA compliance profile forces T0 (observe only). Configure per-agent overrides under Settings → Autonomy policy.
        </p>
      </div>

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
            <div className="text-sm font-medium">Optimization schedule</div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-relaxed">
              Recurring improvement agent. Default is weekly (Monday 09:00 UTC).
              Requires code-change to be enabled for the org before PRs are
              proposed. Cron checks every 5 minutes and only runs when due.
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
