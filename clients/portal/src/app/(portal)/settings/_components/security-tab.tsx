"use client";

import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Shield, ShieldCheck, ShieldAlert, AlertTriangle, User as UserIcon } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  canUseTeamFeatures,
  isPersonalWorkspace,
} from "@/lib/workspace-mode";
import { SettingsCard } from "@/components/settings/settings-card";
import { DangerZone } from "@/components/settings/danger-zone";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import { TwoFASetupDialog } from "./2fa-setup-dialog";

/** Wave 4 Security leaf — 2FA + workspace enforcement (S10 / M14). */
export const WS4_SECURITY_COMPLETED = true as const;

interface Member2FAStatus {
  user_id: string;
  email: string;
  name: string;
  two_factor_enabled: boolean;
  joined_at: string | null;
  last_active_at: string | null;
}

export function SecurityTab() {
  const { currentOrg } = useOrg();
  const { hasPermission } = usePermissions();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);
  const [enforcementOverride, setEnforcementOverride] = useState<boolean | null>(null);

  const canManageSecurity = hasPermission("settings:edit");
  const isPersonal = isPersonalWorkspace(currentOrg);
  const showWorkspaceEnforcement =
    canManageSecurity && Boolean(currentOrg) && canUseTeamFeatures(currentOrg);
  const orgId = currentOrg?.id ?? null;

  const securityQuery = useOrgQuery(
    queryKeys.security.twoFa(orgId),
    orgId,
    async () => {
      const status = await api.get2FAStatus();
      if (!canManageSecurity) {
        return {
          user2FAEnabled: status.two_factor_enabled,
          enforcementStatus: false,
          members2FA: [] as Member2FAStatus[],
        };
      }
      // Fail closed: enforcement/members errors must surface ErrorState,
      // not soft-default to false / [] (which hides outages as "not enforced").
      const [enforcement, members] = await Promise.all([
        api.getOrg2FAEnforcementStatus(orgId!),
        api.getOrgMembers2FAStatus(orgId!),
      ]);
      return {
        user2FAEnabled: status.two_factor_enabled,
        enforcementStatus: enforcement.two_factor_enforced,
        members2FA: members,
      };
    },
  );
  const user2FAEnabled = securityQuery.data?.user2FAEnabled ?? false;
  const members2FA = securityQuery.data?.members2FA ?? [];
  const enforcementStatus =
    enforcementOverride ?? securityQuery.data?.enforcementStatus ?? false;
  const loading = securityQuery.isLoading;
  const loadError = securityQuery.error
    ? errorFromCaught(securityQuery.error, "Failed to load 2FA data")
    : null;
  const loadData = async () => {
    setEnforcementOverride(null);
    await securityQuery.refetch();
  };

  const handleEnforceToggle = async (next: boolean) => {
    if (!currentOrg) return;

    if (next) {
      const non2FAMembers = members2FA.filter((m) => !m.two_factor_enabled);
      if (non2FAMembers.length > 0) {
        const confirmed = await confirm({
          title: "Some members will be locked out",
          description: `${non2FAMembers.length} member(s) do not have 2FA enabled. They will be locked out until they set up 2FA. Continue anyway?`,
          confirmLabel: "Enforce anyway",
          variant: "destructive",
        });
        if (!confirmed) return;
      }
    }

    try {
      await api.enforceOrg2FA(currentOrg.id, next);
      setEnforcementOverride(next);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error(e.message || "Failed to update 2FA enforcement");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-ws4-security="loading">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        <span className="ml-2 text-[var(--text-muted)]">Loading security settings...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div data-ws4-security="error">
        <ErrorState
          title="Could not load 2FA data"
          message={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void loadData()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-space-6" data-ws4-security="completed">
      {currentOrg && (
        <IntegrationStatusBanners integration="security" orgId={currentOrg.id} />
      )}

      <div className="flex items-center gap-space-3">
        <div className="p-space-2 bg-[var(--accent-faint)] rounded-lg">
          <Shield className="w-5 h-5 text-[var(--accent)]" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
          <p className="text-sm text-[var(--text-muted)]">
            {isPersonal
              ? "Secure your account with 2FA"
              : "Secure your account and workspace with 2FA"}
          </p>
        </div>
      </div>

      <SettingsCard
        title="Your 2FA status"
        description={
          user2FAEnabled
            ? "You have 2FA enabled on your account"
            : "You have not enabled 2FA on your account"
        }
        actions={
          user2FAEnabled ? (
            <span className="px-space-3 py-space-1 bg-[var(--terminal-faint)] text-[var(--terminal)] rounded-full text-sm font-medium flex items-center gap-space-1">
              <ShieldCheck className="w-4 h-4" aria-hidden />
              Enabled
            </span>
          ) : (
            <span className="px-space-3 py-space-1 bg-[var(--warning-bg)] text-[var(--warning)] rounded-full text-sm font-medium flex items-center gap-space-1">
              <ShieldAlert className="w-4 h-4" aria-hidden />
              Not Enabled
            </span>
          )
        }
      >
        <div className="flex items-center gap-space-3">
          <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
            <UserIcon className="w-5 h-5 text-[var(--accent)]" aria-hidden />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-[var(--text-secondary)]">
              Authenticator apps protect sign-in even if your password is compromised.
            </p>
          </div>
        </div>
        {user2FAEnabled ? null : (
          <Button
            variant="default"
            className="mt-space-4 min-h-11"
            onClick={() => setShowSetupDialog(true)}
          >
            Set Up 2FA
          </Button>
        )}
      </SettingsCard>

      {user2FAEnabled ? (
        <DangerZone
          title="Disable two-factor authentication"
          description="Turning off 2FA reduces account protection. You will need a recovery code or authenticator to confirm."
        >
          <Button
            variant="outline"
            className="border-[var(--error)] text-[var(--error)] hover:bg-[var(--error-dim)]"
            onClick={() => setShowDisableDialog(true)}
          >
            Disable 2FA
          </Button>
        </DangerZone>
      ) : null}

      {isPersonal && (
        <p className="text-sm text-[var(--text-muted)]" data-ws4-security-personal>
          Workspace-wide 2FA enforcement is available on team workspaces.
        </p>
      )}

      {showWorkspaceEnforcement && currentOrg && (
        <SettingsCard
          title="Workspace 2FA enforcement"
          description={
            enforcementStatus
              ? "All members must enable 2FA to access this workspace"
              : "2FA is not enforced for this workspace"
          }
          actions={
            <Switch
              checked={enforcementStatus}
              onCheckedChange={(v) => void handleEnforceToggle(v)}
              aria-label="Enforce workspace 2FA"
            />
          }
        >
          {enforcementStatus && (
            <div className="p-space-3 bg-[var(--warning-bg)] border border-[var(--warning)] rounded-lg flex items-start gap-space-2">
              <AlertTriangle className="w-5 h-5 text-[var(--warning)] mt-0.5 shrink-0" aria-hidden />
              <div className="text-sm">
                <p className="font-medium text-[var(--warning)]">Warning</p>
                <p className="text-[var(--warning)]">
                  Members without 2FA enabled will be locked out until they set it up.
                  Make sure all members have enabled 2FA before enforcing.
                </p>
              </div>
            </div>
          )}

          <div className={enforcementStatus ? "mt-space-6" : undefined}>
            <h3 className="text-sm font-semibold mb-space-3">Members 2FA status</h3>
            {members2FA.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">No members found.</p>
            ) : (
              <div className="space-y-space-2">
                {members2FA.map((member) => (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between p-space-3 bg-[var(--bg-secondary)] rounded-lg"
                  >
                    <div className="flex items-center gap-space-3">
                      <div className="w-8 h-8 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
                        <span className="text-[var(--accent)] font-medium text-sm">
                          {member.name?.charAt(0).toUpperCase() || "?"}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm">{member.name || "Unknown"}</p>
                        <p className="text-xs text-[var(--text-muted)]">{member.email}</p>
                      </div>
                    </div>
                    {member.two_factor_enabled ? (
                      <span className="px-2 py-1 bg-[var(--terminal-faint)] text-[var(--terminal)] rounded text-xs font-medium flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" aria-hidden />
                        Enabled
                      </span>
                    ) : (
                      <span className="px-2 py-1 bg-[var(--warning-bg)] text-[var(--warning)] rounded text-xs font-medium flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3" aria-hidden />
                        Not Enabled
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      {showSetupDialog && (
        <TwoFASetupDialog
          onClose={() => setShowSetupDialog(false)}
          onSuccess={() => {
            setShowSetupDialog(false);
            void loadData();
          }}
        />
      )}

      {showDisableDialog && (
        <Disable2FADialog
          onClose={() => setShowDisableDialog(false)}
          onSuccess={() => {
            setShowDisableDialog(false);
            void loadData();
          }}
        />
      )}
      {ConfirmDialog}
    </div>
  );
}

function Disable2FADialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.disable2FA(code);
      onSuccess();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Failed to disable 2FA");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !loading && onClose()}>
      <DialogContent
        className="max-w-md"
        aria-describedby="disable-2fa-description"
        onInteractOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Disable 2FA</DialogTitle>
          <DialogDescription id="disable-2fa-description">
            Enter the 6-digit code from your authenticator app to disable 2FA.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-space-4">
          <div>
            <Input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              aria-label="2FA authentication code"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "disable-2fa-error" : undefined}
              className="text-center text-2xl tracking-widest h-12 min-h-12"
              autoFocus
            />
          </div>

          {error && (
            <p id="disable-2fa-error" className="text-sm text-[var(--error)]" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={loading}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              disabled={loading || code.length !== 6}
              loading={loading}
            >
              Disable 2FA
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
