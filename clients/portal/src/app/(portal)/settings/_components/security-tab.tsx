"use client";

import { useState, useEffect } from "react";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { Loader2, Shield, ShieldCheck, ShieldAlert, AlertTriangle, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TwoFASetupDialog } from "./2fa-setup-dialog";

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
  const [user2FAEnabled, setUser2FAEnabled] = useState(false);
  const [enforcementStatus, setEnforcementStatus] = useState(false);
  const [members2FA, setMembers2FA] = useState<Member2FAStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  const canManageSecurity = hasPermission("settings:edit");

  const loadData = async () => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Get user's own 2FA status
      const status = await api.get2FAStatus();
      setUser2FAEnabled(status.two_factor_enabled);

      // Get org enforcement status (admins only)
      if (canManageSecurity) {
        const [enforcement, members] = await Promise.all([
          api.getOrg2FAEnforcementStatus(currentOrg.id).catch(() => ({ two_factor_enforced: false })),
          api.getOrgMembers2FAStatus(currentOrg.id).catch(() => []),
        ]);
        setEnforcementStatus(enforcement.two_factor_enforced);
        setMembers2FA(members);
      }
    } catch (e) {
      console.error("Failed to load 2FA data", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [currentOrg?.id, canManageSecurity]);

  const handleEnforceToggle = async () => {
    if (!currentOrg) return;

    const newEnforce = !enforcementStatus;

    if (newEnforce) {
      // Warn about potential lockout
      const non2FAMembers = members2FA.filter((m) => !m.two_factor_enabled);
      if (non2FAMembers.length > 0) {
        const confirmed = window.confirm(
          `Warning: ${non2FAMembers.length} member(s) do not have 2FA enabled. ` +
            `They will be locked out until they set up 2FA. Continue anyway?`
        );
        if (!confirmed) return;
      }
    }

    try {
      await api.enforceOrg2FA(currentOrg.id, newEnforce);
      setEnforcementStatus(newEnforce);
    } catch (e: any) {
      alert(e.message || "Failed to update 2FA enforcement");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <span className="ml-2 text-gray-500">Loading security settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 rounded-lg">
          <Shield className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Two-Factor Authentication</h2>
          <p className="text-sm text-gray-500">
            Secure your account and organization with 2FA
          </p>
        </div>
      </div>

      {/* User's Own 2FA Section */}
      <div className="p-4 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
            <UserIcon className="w-5 h-5 text-blue-600" />
          </div>
          <div className="flex-1">
            <p className="font-medium">Your 2FA Status</p>
            <p className="text-sm text-gray-500">
              {user2FAEnabled
                ? "You have 2FA enabled on your account"
                : "You have not enabled 2FA on your account"}
            </p>
          </div>
          {user2FAEnabled ? (
            <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium flex items-center gap-1">
              <ShieldCheck className="w-4 h-4" />
              Enabled
            </span>
          ) : (
            <span className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full text-sm font-medium flex items-center gap-1">
              <ShieldAlert className="w-4 h-4" />
              Not Enabled
            </span>
          )}
        </div>

        {user2FAEnabled ? (
          <button
            onClick={() => setShowDisableDialog(true)}
            className="px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
          >
            Disable 2FA
          </button>
        ) : (
          <button
            onClick={() => setShowSetupDialog(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            Set Up 2FA
          </button>
        )}
      </div>

      {/* Org 2FA Enforcement Section - Admin/Owner only */}
      {canManageSecurity && currentOrg && (
        <div className="p-4 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1">
              <p className="font-medium">Organization 2FA Enforcement</p>
              <p className="text-sm text-gray-500">
                {enforcementStatus
                  ? "All members must enable 2FA to access the organization"
                  : "2FA is not enforced for this organization"}
              </p>
            </div>
            <button
              onClick={handleEnforceToggle}
              className={cn(
                "relative w-12 h-6 rounded-full transition-colors",
                enforcementStatus ? "bg-blue-600" : "bg-gray-300"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                  enforcementStatus && "translate-x-6"
                )}
              />
            </button>
          </div>

          {enforcementStatus && (
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-yellow-800">Warning</p>
                <p className="text-yellow-700">
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
                <p className="text-sm text-gray-500">No members found.</p>
              ) : (
                <div className="space-y-2">
                  {members2FA.map((member) => (
                    <div
                      key={member.user_id}
                      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                          <span className="text-blue-600 font-medium text-sm">
                            {member.name?.charAt(0).toUpperCase() || "?"}
                          </span>
                        </div>
                        <div>
                          <p className="font-medium text-sm">{member.name || "Unknown"}</p>
                          <p className="text-xs text-gray-500">{member.email}</p>
                        </div>
                      </div>
                      {member.two_factor_enabled ? (
                        <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" />
                          Enabled
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium flex items-center gap-1">
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
            setUser2FAEnabled(true);
            loadData();
          }}
        />
      )}

      {/* Disable 2FA Dialog */}
      {showDisableDialog && (
        <Disable2FADialog
          onClose={() => setShowDisableDialog(false)}
          onSuccess={() => {
            setShowDisableDialog(false);
            setUser2FAEnabled(false);
          }}
        />
      )}
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
    } catch (e: any) {
      setError(e.message || "Failed to disable 2FA");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--surface)] rounded-xl p-6 w-full max-w-md mx-4">
        <h2 className="text-lg font-semibold mb-4">Disable 2FA</h2>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          Enter the 6-digit code from your authenticator app to disable 2FA.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              className="w-full px-3 py-2 text-center text-2xl tracking-widest border border-[var(--border)] rounded-lg"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm border border-[var(--border)] rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Disable 2FA"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}