"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Shield, ShieldCheck, ShieldAlert, AlertTriangle, User as UserIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import { TwoFASetupDialog } from "./2fa-setup-dialog";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import { DangerZone } from "@/components/settings/danger-zone";

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
  const isPersonalOrg = Boolean(currentOrg?.is_personal);
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

  const handleEnforceToggle = async () => {
    if (!currentOrg) return;

    const newEnforce = !enforcementStatus;

    if (newEnforce) {
      // Warn about potential lockout
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
      await api.enforceOrg2FA(currentOrg.id, newEnforce);
      setEnforcementOverride(newEnforce);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error(e.message || "Failed to update 2FA enforcement");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        <span className="ml-2 text-[var(--text-muted)]">Loading security settings...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        title="Could not load 2FA data"
        message={loadError}
        action={
          <Button variant="outline" size="sm" onClick={() => void loadData()}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-space-6">
      {currentOrg && (
        <IntegrationStatusBanners integration="security" orgId={currentOrg.id} />
      )}

      {/* Header */}
      <div className="flex items-center gap-space-3">
        <div className="p-space-2 bg-[var(--accent-faint)] rounded-lg">
          <Shield className="w-5 h-5 text-[var(--accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Secure your account and organization with 2FA
          </p>
        </div>
      </div>

      {/* User's Own 2FA Section */}
      <div className="p-space-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)] space-y-space-4">
        <div className="flex items-center gap-space-3">
          <div className="w-10 h-10 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
            <UserIcon className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div className="flex-1">
            <p className="font-medium">Your 2FA Status</p>
            <p className="text-sm text-[var(--text-muted)]">
              {user2FAEnabled
                ? "You have 2FA enabled on your account"
                : "You have not enabled 2FA on your account"}
            </p>
          </div>
          {user2FAEnabled ? (
            <span className="px-space-3 py-space-1 bg-[var(--terminal-faint)] text-[var(--terminal)] rounded-full text-sm font-medium flex items-center gap-space-1">
              <ShieldCheck className="w-4 h-4" />
              Enabled
            </span>
          ) : (
            <span className="px-space-3 py-space-1 bg-[var(--warning-bg)] text-[var(--warning)] rounded-full text-sm font-medium flex items-center gap-space-1">
              <ShieldAlert className="w-4 h-4" />
              Not Enabled
            </span>
          )}
        </div>

        {user2FAEnabled ? null : (
          <Button variant="default" className="min-h-11" onClick={() => setShowSetupDialog(true)}>
            Set Up 2FA
          </Button>
        )}
      </div>

      {user2FAEnabled ? (
        <DangerZone
          title="Disable two-factor authentication"
          description="Turning off 2FA reduces account protection. You will need a recovery code or authenticator to confirm."
        >
          <button
            onClick={() => setShowDisableDialog(true)}
            className="px-space-4 py-space-2 text-sm border border-[var(--error)] text-[var(--error)] rounded-lg hover:bg-[var(--error-dim)]"
          >
            Disable 2FA
          </button>
        </DangerZone>
      ) : null}

      {/* Org 2FA Enforcement — admin/owner only; soft-hide for personal workspaces */}
      {canManageSecurity && currentOrg && !isPersonalOrg && (
        <div className="p-4 bg-[var(--bg-primary)] rounded-lg border border-[var(--border-default)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1">
              <p className="font-medium">Organization 2FA Enforcement</p>
              <p className="text-sm text-[var(--text-muted)]">
                {enforcementStatus
                  ? "All members must enable 2FA to access the organization"
                  : "2FA is not enforced for this organization"}
              </p>
            </div>
            <button
              onClick={handleEnforceToggle}
              className={cn(
                "relative w-12 h-6 rounded-full transition-colors",
                enforcementStatus ? "bg-[var(--accent)]" : "bg-[var(--border-default)]"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 left-0.5 w-5 h-5 bg-[var(--bg-primary)] rounded-full transition-transform",
                  enforcementStatus && "translate-x-6"
                )}
              />
            </button>
          </div>

          {enforcementStatus && (
            <div className="p-3 bg-[var(--warning-bg)] border border-[var(--warning)] rounded-lg flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-[var(--warning)] mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-[var(--warning)]">Warning</p>
                <p className="text-[var(--warning)]">
                  Members without 2FA enabled will be locked out until they set it up.
                  Make sure all members have enabled 2FA before enforcing.
                </p>
              </div>
            </div>
          )}

          {/* Members 2FA Status */}
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            <div className="mt-6">
              <h3 className="text-sm font-semibold mb-3">Members 2FA Status</h3>
              {members2FA.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No members found.</p>
              ) : (
                <div className="space-y-space-2">
                  {members2FA.map((member) => (
                    <div
                      key={member.user_id}
                      className="flex items-center justify-between p-3 bg-[var(--bg-secondary)] rounded-lg"
                    >
                      <div className="flex items-center gap-3">
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
                          <ShieldCheck className="w-3 h-3" />
                          Enabled
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-[var(--warning-bg)] text-[var(--warning)] rounded text-xs font-medium flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3" />
                          Not Enabled
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 2FA Setup Dialog */}
      {showSetupDialog && (
        <TwoFASetupDialog
          onClose={() => setShowSetupDialog(false)}
          onSuccess={() => {
            setShowSetupDialog(false);
            void loadData();
          }}
        />
      )}

      {/* Disable 2FA Dialog */}
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

  const handleSubmit = async (e: React.FormEvent) => {
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
    <DialogPrimitive.Root open onOpenChange={(open) => !open && !loading && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: "color-mix(in srgb, var(--bg-base) 50%, transparent)" }}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-md max-h-[90vh] overflow-y-auto translate-x-[-50%] translate-y-[-50%]",
            "gap-4 border border-[var(--border-default)] bg-[var(--bg-primary)] p-6 shadow-lg rounded-xl",
            "duration-200"
          )}
          aria-describedby="disable-2fa-description"
        >
          <DialogPrimitive.Title className="text-lg font-semibold mb-4">
            Disable 2FA
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            id="disable-2fa-description"
            className="text-sm text-[var(--text-secondary)] mb-4"
          >
            Enter the 6-digit code from your authenticator app to disable 2FA.
          </DialogPrimitive.Description>

          <form onSubmit={handleSubmit} className="space-y-space-4">
            <div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                aria-label="2FA authentication code"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "disable-2fa-error" : undefined}
                className="w-full px-3 py-2 text-center text-2xl tracking-widest border border-[var(--border)] rounded-lg"
                autoFocus
              />
            </div>

            {error && (
              <p id="disable-2fa-error" className="text-sm text-[var(--error)]" role="alert">
                {error}
              </p>
            )}

            <div className="flex gap-3 justify-end">
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  className="px-4 py-2 text-sm border border-[var(--border)] rounded-lg"
                  disabled={loading}
                >
                  Cancel
                </button>
              </DialogPrimitive.Close>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="px-4 py-2 bg-[var(--error)] text-[var(--bg-primary)] rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : "Disable 2FA"}
              </button>
            </div>
          </form>

          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-md p-1 text-[var(--text-muted)] opacity-70 transition-opacity hover:opacity-100 hover:bg-[var(--accent-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            aria-label="Close dialog"
            disabled={loading}
          >
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}