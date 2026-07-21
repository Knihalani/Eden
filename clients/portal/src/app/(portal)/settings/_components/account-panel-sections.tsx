"use client";

import { useRef, type ChangeEvent, type FormEvent } from "react";
import Image from "next/image";
import {
  Loader2,
  User,
  Mail,
  Lock,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Camera,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { SettingsCard } from "@/components/settings/settings-card";

export function AccountProfileCard({
  name,
  email,
  userId,
  avatarUrl,
  saving,
  saveSuccess,
  uploadingAvatar,
  onNameChange,
  onSave,
  onAvatarUpload,
}: {
  name: string;
  email: string;
  userId: string;
  avatarUrl: string | null;
  saving: boolean;
  saveSuccess: boolean;
  uploadingAvatar: boolean;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onAvatarUpload: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <SettingsCard
      title="Your profile"
      description="Personal account details — name, photo, and sign-in email."
    >
      <div className="space-y-space-6" data-testid="profile-user-section">
        <div className="flex items-center gap-space-4">
          <div className="relative">
            <div className="user-avatar w-20 h-20 rounded-full flex items-center justify-center text-2xl overflow-hidden bg-[var(--bg-tertiary)]">
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt="Your profile photo"
                  width={80}
                  height={80}
                  unoptimized
                  className="w-full h-full object-cover"
                />
              ) : (
                name.charAt(0).toUpperCase()
              )}
            </div>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              loading={uploadingAvatar}
              aria-label={uploadingAvatar ? "Uploading avatar" : "Upload avatar"}
              className="absolute bottom-0 right-0 h-8 w-8 min-h-8 min-w-8 rounded-full"
            >
              {!uploadingAvatar ? <Camera className="w-4 h-4" aria-hidden /> : null}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onAvatarUpload}
              className="hidden"
              aria-label="Upload profile photo"
            />
          </div>
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Profile photo</p>
            <p className="text-xs text-[var(--text-muted)]">JPG, PNG or GIF. Max 2MB.</p>
          </div>
        </div>

        <div className="space-y-space-4">
          <FormField label="Name" htmlFor="profile-name">
            <div className="relative">
              <User
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
                aria-hidden
              />
              <input
                id="profile-name"
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                className="w-full pl-10 pr-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
              />
            </div>
          </FormField>

          <FormField
            label="Email"
            htmlFor="profile-email"
            description="Email cannot be changed from this page."
          >
            <div className="relative">
              <Mail
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]"
                aria-hidden
              />
              <input
                id="profile-email"
                type="email"
                value={email}
                readOnly
                aria-readonly="true"
                className="w-full pl-10 pr-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-muted)] text-[var(--text-secondary)] cursor-default"
              />
            </div>
          </FormField>

          <div>
            <p className="block text-sm font-medium text-[var(--text-secondary)] mb-space-1">
              User ID
            </p>
            <p
              aria-label={`User ID ${userId}`}
              className="text-sm text-[var(--text-primary)] font-mono bg-[var(--bg-muted)] px-space-3 py-space-2 rounded-lg inline-block"
            >
              {userId}
            </p>
          </div>

          <div className="pt-space-2">
            <Button onClick={onSave} disabled={saving || !name.trim()} loading={saving}>
              {saveSuccess ? (
                <>
                  <Check className="w-4 h-4" aria-hidden />
                  Saved
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}

export function AccountPasswordCard({
  currentPassword,
  newPassword,
  confirmPassword,
  passwordError,
  passwordSuccess,
  changingPassword,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  passwordError: string;
  passwordSuccess: string;
  changingPassword: boolean;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <SettingsCard title="Change password" description="Update the password for your account.">
      <form onSubmit={onSubmit} className="space-y-space-4">
        <div className="flex items-center gap-space-3 mb-space-1">
          <div className="p-2 bg-[var(--accent-faint)] rounded-lg">
            <Lock className="w-5 h-5 text-[var(--accent)]" aria-hidden />
          </div>
          <p className="text-sm text-[var(--text-muted)]">Requires your current password.</p>
        </div>

        <FormField label="Current password" htmlFor="profile-current-password">
          <input
            id="profile-current-password"
            type="password"
            value={currentPassword}
            onChange={(e) => onCurrentPasswordChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            autoComplete="current-password"
          />
        </FormField>

        <FormField label="New password" htmlFor="profile-new-password">
          <input
            id="profile-new-password"
            type="password"
            value={newPassword}
            onChange={(e) => onNewPasswordChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            autoComplete="new-password"
          />
        </FormField>

        <FormField label="Confirm new password" htmlFor="profile-confirm-password">
          <input
            id="profile-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            autoComplete="new-password"
          />
        </FormField>

        {passwordError ? (
          <p role="alert" className="text-sm text-[var(--error)]">
            {passwordError}
          </p>
        ) : null}

        {passwordSuccess ? (
          <p className="text-sm text-[var(--terminal)] flex items-center gap-1">
            <Check className="w-4 h-4" aria-hidden />
            {passwordSuccess}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
          loading={changingPassword}
        >
          Change password
        </Button>
      </form>
    </SettingsCard>
  );
}

export function Account2FACard({
  loading2FA,
  twoFaError,
  twoFactorEnabled,
  onRetry,
  onDisable,
  onSetup,
}: {
  loading2FA: boolean;
  twoFaError: string | null;
  twoFactorEnabled: boolean;
  onRetry: () => void;
  onDisable: () => void;
  onSetup: () => void;
}) {
  return (
    <SettingsCard
      title="Two-factor authentication"
      description="Extra protection for your personal sign-in."
    >
      {loading2FA ? (
        <div className="flex items-center gap-2" aria-live="polite">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          <span className="text-sm text-[var(--text-muted)]">Loading…</span>
        </div>
      ) : twoFaError ? (
        <ErrorState
          title="Could not load 2FA status"
          message={twoFaError}
          size="sm"
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : (
        <div className="flex items-center justify-between gap-space-4 flex-wrap">
          <div className="flex items-center gap-space-3">
            <div
              className={cn(
                "p-2 rounded-lg",
                twoFactorEnabled ? "bg-[var(--terminal-faint)]" : "bg-[var(--warning-bg)]",
              )}
            >
              <Shield
                className={cn(
                  "w-5 h-5",
                  twoFactorEnabled ? "text-[var(--terminal)]" : "text-[var(--warning)]",
                )}
                aria-hidden
              />
            </div>
            {twoFactorEnabled ? (
              <>
                <span className="px-3 py-1 bg-[var(--terminal-faint)] text-[var(--terminal)] text-sm font-medium rounded-full flex items-center gap-1">
                  <ShieldCheck className="w-4 h-4" aria-hidden />
                  Enabled
                </span>
                <p className="text-sm text-[var(--text-secondary)]">
                  Your account is protected with 2FA
                </p>
              </>
            ) : (
              <>
                <span className="px-3 py-1 bg-[var(--warning-bg)] text-[var(--warning)] text-sm font-medium rounded-full flex items-center gap-1">
                  <ShieldAlert className="w-4 h-4" aria-hidden />
                  Not enabled
                </span>
                <p className="text-sm text-[var(--text-secondary)]">
                  Add an extra layer of security to your account
                </p>
              </>
            )}
          </div>

          {twoFactorEnabled ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={onDisable}
              aria-label="Disable two-factor authentication"
            >
              Disable 2FA
            </Button>
          ) : (
            <Button size="sm" onClick={onSetup} aria-label="Set up two-factor authentication">
              Set up 2FA
            </Button>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

export function AccountDataCard({
  exportingData,
  onExport,
}: {
  exportingData: boolean;
  onExport: () => void;
}) {
  return (
    <SettingsCard
      title="Your data"
      description="GDPR Art. 15 — request a copy of your personal data."
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-[var(--text-secondary)] max-w-xl">
          We queue an export job, write it to secure storage, and email a download link when ready.
        </p>
        <Button size="sm" variant="secondary" loading={exportingData} onClick={onExport}>
          Request data export
        </Button>
      </div>
    </SettingsCard>
  );
}
