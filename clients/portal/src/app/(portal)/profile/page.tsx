"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, User, Mail, Lock, Shield, ShieldCheck, ShieldAlert, Trash2, Camera, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { TwoFASetupDialog } from "../settings/_components/2fa-setup-dialog";

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Password change
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  // 2FA
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [loading2FA, setLoading2FA] = useState(true);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  // Delete account
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Avatar upload
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    load2FAStatus();
  }, []);

  const load2FAStatus = async () => {
    setLoading2FA(true);
    try {
      const status = await api.get2FAStatus();
      setTwoFactorEnabled(status.two_factor_enabled);
    } catch (e) {
      console.error("Failed to load 2FA status", e);
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
    } catch (e: any) {
      toast.error(e.message || "Failed to save profile");
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
    } catch (e: any) {
      setPasswordError(e.message || "Failed to change password");
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
      // Render the new avatar URL immediately so the UI doesn't
      // wait for the refreshUser() round-trip to settle.
      if (result?.avatar_url) setAvatarUrl(result.avatar_url);
      await refreshUser();
    } catch (e: any) {
      toast.error(e.message || "Failed to upload avatar");
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
      description: "This will permanently delete your account and all associated organizations.",
      confirmLabel: "Delete forever",
      variant: "destructive",
    });
    if (!secondConfirm) return;

    setDeleting(true);
    try {
      await api.deleteAccount("DELETE");
      window.location.href = "/";
    } catch (e: any) {
      toast.error(e.message || "Failed to delete account");
      setDeleting(false);
    }
  };

  if (!user) return null;

  return (
    <div className="p-6 max-w-2xl">
      <PageHeader
        title="Profile"
        subtitle="Manage your account settings"
        icon={User}
      />

      {/* User Info Section */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border)] p-6 mb-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">User Information</h2>

        {/* Avatar Upload */}
        <div className="flex items-center gap-4 mb-6">
          <div className="relative">
            <div className="user-avatar w-20 h-20 rounded-full flex items-center justify-center text-2xl overflow-hidden bg-[var(--bg-tertiary)]">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt="Your profile photo"
                  className="w-full h-full object-cover"
                />
              ) : (
                name.charAt(0).toUpperCase()
              )}
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              aria-label="Upload avatar"
              className="absolute bottom-0 right-0 w-8 h-8 bg-[var(--bg-primary)] border border-[var(--border)] rounded-full flex items-center justify-center hover:bg-[var(--bg-muted)] transition-colors"
            >
              {uploadingAvatar ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Camera className="w-4 h-4" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarUpload}
              className="hidden"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Profile Photo</p>
            <p className="text-xs text-[var(--text-muted)]">JPG, PNG or GIF. Max 2MB.</p>
          </div>
        </div>

        {/* Name Input */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Name</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full pl-10 pr-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
            </div>
          </div>

          {/* Email Input */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-10 pr-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
            </div>
          </div>

          {/* User ID (read-only) */}
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">User ID</label>
            <p className="text-sm text-[var(--text-primary)] font-mono bg-[var(--bg-muted)] px-3 py-2 rounded-lg inline-block">
              {user.user_id}
            </p>
          </div>

          {/* Save Button */}
          <div className="pt-2">
            <Button onClick={handleSaveProfile} disabled={saving || !name.trim()}>
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saveSuccess ? (
                <>
                  <Check className="w-4 h-4" />
                  Saved
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Password Change Section */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border)] p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
            <Lock className="w-5 h-5 text-[var(--accent)]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Change Password</h2>
            <p className="text-sm text-[var(--text-muted)]">Update your password</p>
          </div>
        </div>

        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              autoComplete="current-password"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              autoComplete="new-password"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              autoComplete="new-password"
            />
          </div>

          {passwordError && (
            <p className="text-sm text-[var(--error)]">{passwordError}</p>
          )}

          {passwordSuccess && (
            <p className="text-sm text-[var(--terminal)] flex items-center gap-1">
              <Check className="w-4 h-4" />
              {passwordSuccess}
            </p>
          )}

          <Button type="submit" disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}>
            {changingPassword ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Change Password"
            )}
          </Button>
        </form>
      </div>

      {/* 2FA Section */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--border)] p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className={cn("p-2 rounded-lg", twoFactorEnabled ? "bg-[var(--terminal-faint)]" : "bg-[var(--warning-bg)]")}>
            <Shield className={cn("w-5 h-5", twoFactorEnabled ? "text-[var(--terminal)]" : "text-[var(--warning)]")} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Two-Factor Authentication</h2>
            <p className="text-sm text-[var(--text-muted)]">Secure your account with 2FA</p>
          </div>
        </div>

        {loading2FA ? (
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm text-[var(--text-muted)]">Loading...</span>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {twoFactorEnabled ? (
                <>
                  <span className="px-3 py-1 bg-[var(--terminal-faint)] text-[var(--terminal)] text-sm font-medium rounded-full flex items-center gap-1">
                    <ShieldCheck className="w-4 h-4" />
                    Enabled
                  </span>
                  <p className="text-sm text-[var(--text-secondary)]">Your account is protected with 2FA</p>
                </>
              ) : (
                <>
                  <span className="px-3 py-1 bg-[var(--warning-bg)] text-[var(--warning)] text-sm font-medium rounded-full flex items-center gap-1">
                    <ShieldAlert className="w-4 h-4" />
                    Not Enabled
                  </span>
                  <p className="text-sm text-[var(--text-secondary)]">Add an extra layer of security to your account</p>
                </>
              )}
            </div>

            {twoFactorEnabled ? (
              <Button variant="destructive" size="sm" onClick={() => setShowDisableDialog(true)}>
                Disable 2FA
              </Button>
            ) : (
              <Button size="sm" onClick={() => setShowSetupDialog(true)}>
                Set Up 2FA
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="bg-[var(--bg-primary)] rounded-lg border border-[var(--error)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[var(--error-dim)] rounded-lg">
            <Trash2 className="w-5 h-5 text-[var(--error)]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--error)]">Danger Zone</h2>
            <p className="text-sm text-[var(--text-muted)]">Irreversible actions</p>
          </div>
        </div>

        <div className="flex items-center justify-between p-4 border border-[var(--error)] rounded-lg bg-[var(--error-dim)]">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Delete Account</p>
            <p className="text-xs text-[var(--text-secondary)]">Permanently delete your account and all data</p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete Account"}
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-[var(--bg-base)]/50 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-primary)] rounded-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-[var(--error-dim)] rounded-lg">
                <Trash2 className="w-5 h-5 text-[var(--error)]" />
              </div>
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Delete Account</h2>
            </div>

            <p className="text-sm text-[var(--text-secondary)] mb-4">
              Are you absolutely sure you want to delete your account? This action:
            </p>
            <ul className="text-sm text-[var(--text-secondary)] mb-4 list-disc list-inside space-y-1">
              <li>Cannot be undone</li>
              <li>Will permanently delete all your data</li>
              <li>Will remove you from all organizations</li>
              <li>Will cancel all active subscriptions</li>
            </ul>

            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDeleteAccount} disabled={deleting}>
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete Forever"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 2FA Setup Dialog */}
      {showSetupDialog && (
        <TwoFASetupDialog
          onClose={() => setShowSetupDialog(false)}
          onSuccess={() => {
            setShowSetupDialog(false);
            setTwoFactorEnabled(true);
          }}
        />
      )}

      {/* 2FA Disable Dialog */}
      {showDisableDialog && (
        <Disable2FADialog
          onClose={() => setShowDisableDialog(false)}
          onSuccess={() => {
            setShowDisableDialog(false);
            setTwoFactorEnabled(false);
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
    } catch (e: any) {
      setError(e.message || "Failed to disable 2FA");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[var(--bg-base)]/50 flex items-center justify-center z-50">
      <div className="bg-[var(--bg-primary)] rounded-xl p-6 w-full max-w-md mx-4">
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
            <p className="text-sm text-[var(--error)]">{error}</p>
          )}

          <div className="flex gap-3 justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={loading || code.length !== 6}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Disable 2FA"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}