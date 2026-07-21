"use client";

/**
 * Inline account panel for Settings · Account.
 * Not a full page — no PageHeader / PageContent chrome.
 * Personal profile only (me) — not workspace/org identity.
 */

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/hooks/use-confirm";
import { TwoFASetupDialog } from "./2fa-setup-dialog";
import { Disable2FADialog } from "./disable-2fa-dialog";
import { DangerZone } from "@/components/settings/danger-zone";
import { errorFromCaught } from "@/lib/safe-error-message";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import {
  Account2FACard,
  AccountDataCard,
  AccountPasswordCard,
  AccountProfileCard,
} from "./account-panel-sections";
import { CookiePreferencesRow } from "@/components/settings/cookie-preferences-row";

/** Wave 3 Account leaf exit marker. */
export const WS3_ACCOUNT_COMPLETED = true;

export function AccountPanel() {
  const {
    user,
    loading: authLoading,
    error: authError,
    refreshUser,
  } = useAuth();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [loading2FA, setLoading2FA] = useState(true);
  const [twoFaError, setTwoFaError] = useState<string | null>(null);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [exportingData, setExportingData] = useState(false);

  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setEmail(user.email);
      setAvatarUrl(user.avatar_url ?? null);
    }
  }, [user]);

  useEffect(() => {
    void load2FAStatus();
  }, []);

  const load2FAStatus = async () => {
    setLoading2FA(true);
    setTwoFaError(null);
    try {
      const status = await api.get2FAStatus();
      setTwoFactorEnabled(status.two_factor_enabled);
    } catch (e) {
      setTwoFaError(errorFromCaught(e, "Could not load 2FA status"));
    } finally {
      setLoading2FA(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      await api.updateProfile({ name: name.trim() });
      setSaveSuccess(true);
      await refreshUser();
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (e) {
      toast.error("Failed to save profile", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess("");
    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }
    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setPasswordSuccess("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSuccess(""), 3000);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setChangingPassword(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2MB");
      return;
    }
    setUploadingAvatar(true);
    try {
      const result = await api.uploadAvatar(file);
      if (result?.avatar_url) setAvatarUrl(result.avatar_url);
      await refreshUser();
    } catch (err) {
      toast.error("Failed to upload avatar", err instanceof Error ? err.message : undefined);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleDeleteAccount = async () => {
    const firstConfirm = await confirm({
      title: "Delete your account?",
      description: "This action cannot be undone and all your data will be permanently deleted.",
      confirmLabel: "Continue",
      variant: "destructive",
    });
    if (!firstConfirm) return;
    const secondConfirm = await confirm({
      title: "Are you absolutely sure?",
      description: "This will permanently delete your account and all associated workspaces.",
      confirmLabel: "Delete forever",
      variant: "destructive",
    });
    if (!secondConfirm) return;
    setDeleting(true);
    try {
      await api.deleteAccount("DELETE");
      window.location.href = "/";
    } catch (e) {
      toast.error("Failed to delete account", e instanceof Error ? e.message : undefined);
      setDeleting(false);
    }
  };

  const handleExportData = async () => {
    setExportingData(true);
    try {
      const res = await fetch("/api/proxy/api/v1/me/data", { method: "GET" });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const body = await res.json();
      toast.success("Export queued", `Job ${body.job_id} — check your email when ready.`);
    } catch (e) {
      toast.error("Export failed", e instanceof Error ? e.message : undefined);
    } finally {
      setExportingData(false);
    }
  };

  if (authLoading) {
    return <LoadingSkeleton size="narrow" />;
  }
  if (authError && !user) {
    return (
      <ErrorState
        title="Could not load account"
        message={authError}
        action={
          <Button variant="outline" size="sm" onClick={() => void refreshUser()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!user) return null;

  return (
    <div
      className="space-y-space-6"
      data-testid="account-panel"
      data-ws3-account="true"
    >
      <IntegrationStatusBanners integration="storage" />

      <AccountProfileCard
        name={name}
        email={email}
        userId={user.user_id}
        avatarUrl={avatarUrl}
        saving={saving}
        saveSuccess={saveSuccess}
        uploadingAvatar={uploadingAvatar}
        onNameChange={setName}
        onSave={() => void handleSaveProfile()}
        onAvatarUpload={(e) => void handleAvatarUpload(e)}
      />

      <AccountPasswordCard
        currentPassword={currentPassword}
        newPassword={newPassword}
        confirmPassword={confirmPassword}
        passwordError={passwordError}
        passwordSuccess={passwordSuccess}
        changingPassword={changingPassword}
        onCurrentPasswordChange={setCurrentPassword}
        onNewPasswordChange={setNewPassword}
        onConfirmPasswordChange={setConfirmPassword}
        onSubmit={(e) => void handleChangePassword(e)}
      />

      <Account2FACard
        loading2FA={loading2FA}
        twoFaError={twoFaError}
        twoFactorEnabled={twoFactorEnabled}
        onRetry={() => void load2FAStatus()}
        onDisable={() => setShowDisableDialog(true)}
        onSetup={() => setShowSetupDialog(true)}
      />

      <AccountDataCard
        exportingData={exportingData}
        onExport={() => void handleExportData()}
      />

      <CookiePreferencesRow />

      <DangerZone title="Danger zone" description="Irreversible actions for your personal account.">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Delete account</p>
            <p className="text-xs text-[var(--text-secondary)]">
              Permanently delete your account and all data
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleDeleteAccount()}
            disabled={deleting}
            loading={deleting}
            aria-label="Delete account"
          >
            Delete account
          </Button>
        </div>
      </DangerZone>

      {showSetupDialog ? (
        <TwoFASetupDialog
          onClose={() => setShowSetupDialog(false)}
          onSuccess={() => {
            setShowSetupDialog(false);
            setTwoFactorEnabled(true);
          }}
        />
      ) : null}

      {showDisableDialog ? (
        <Disable2FADialog
          onClose={() => setShowDisableDialog(false)}
          onSuccess={() => {
            setShowDisableDialog(false);
            setTwoFactorEnabled(false);
          }}
        />
      ) : null}
      {ConfirmDialog}
    </div>
  );
}
