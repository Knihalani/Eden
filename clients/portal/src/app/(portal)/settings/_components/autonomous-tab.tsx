"use client";

/**
 * Settings > Autonomous — toggle the Cat 14 destructive actions
 * (SelfHealer, auto-promote, etc.) and the Cat 1-23 intelligence
 * surface per-org. Defaults to ON (matches the Settings default
 * since June 2026). Only org admins can change.
 *
 * Settings are persisted via PATCH /orgs/{org_id}/settings on the
 * backend. The keys ``intelligence_gap_v0`` and
 * ``autonomous_actions_v0`` are read by the route-layer
 * ``require_feature_flag`` checks on the backend.
 */
import { useEffect, useState } from "react";
import {
  Bot,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";

type Flags = {
  intelligence_gap_v0: boolean;
  autonomous_actions_v0: boolean;
};

export default function AutonomousTab() {
  const { currentOrg, refreshOrgs } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const [flags, setFlags] = useState<Flags>({
    intelligence_gap_v0: true,
    autonomous_actions_v0: true,
  });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

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

  if (!currentOrg) return null;

  return (
    <div className="space-y-6">
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
          ? "border-amber-700/40 bg-amber-950/10"
          : "border-[var(--border-default)] bg-[var(--bg-secondary)]/30"
      }`}
    >
      <div
        className={`rounded-lg p-2 shrink-0 ${
          enabled ? "bg-emerald-950/30" : "bg-[var(--bg-base)]"
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
                    ? "bg-amber-500"
                    : "bg-emerald-500"
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
          <p className="text-[11px] text-amber-400/80 mt-2">
            Active. Every destructive action still requires an admin's
            explicit approval via the Inbox or the heal queue.
          </p>
        )}
      </div>
    </div>
  );
}
