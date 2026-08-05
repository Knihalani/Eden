"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { api } from "@/lib/api/resources";
import { useLabToast } from "@/lab/lab-toast";

const CONFIRM_PHRASE = "DELETE";

/**
 * Self-service "Delete my account" — GDPR Art. 17 (right to erasure).
 *
 * Calls the single real erasure code path (``DELETE /users/me`` ->
 * ``eden.services.compliance_jobs.erase_user_account``), which runs a
 * full RightToBeForgottenService pass (Postgres anonymisation +
 * cross-store fanout) per org the caller belongs to, then anonymises
 * the account itself and rotates the session token. Irreversible, so
 * this requires the caller to type the confirmation phrase before the
 * destructive button becomes clickable — same shape as the API-key
 * revoke flow in ``settings-keys-view.tsx``, but with a literal
 * type-to-confirm step given the blast radius.
 */
export function AccountDangerZoneCard() {
  const { pushToast } = useLabToast();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const canConfirm = confirmText.trim() === CONFIRM_PHRASE;

  const handleDelete = () => {
    if (!canConfirm || deleting) return;
    setDeleting(true);
    void (async () => {
      try {
        await api.deleteAccount(CONFIRM_PHRASE);
        pushToast({
          title: "Account deleted",
          body: "Your account and data are being erased. Signing you out…",
          tone: "ok",
        });
        await signOut({ redirectUrl: "/" });
      } catch (err) {
        setDeleting(false);
        pushToast({
          title: "Deletion failed",
          body:
            err instanceof Error
              ? err.message
              : "Please try again or contact support.",
          tone: "fail",
        });
      }
    })();
  };

  return (
    <section className="border-b border-[var(--line)] px-4 py-5 sm:px-6">
      <p className="type-label mb-1 !text-[var(--error)]">Danger zone</p>
      <p className="type-meta mb-4 max-w-xl">
        Deleting your account permanently anonymises your profile, revokes
        API sessions, and erases your data — including telemetry, traces,
        and conversation history you own — across every workspace you
        belong to. This cannot be undone.
      </p>

      {!open ? (
        <button
          type="button"
          className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
          onClick={() => setOpen(true)}
        >
          Delete my account
        </button>
      ) : (
        <div className="max-w-sm rounded-[var(--radius)] border border-[var(--error)]/30 bg-[var(--error)]/5 p-3.5">
          <p className="type-ui text-[var(--text)]">
            Type <span className="font-mono font-semibold">DELETE</span> to
            confirm.
          </p>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="ds-input mt-2 w-full"
            placeholder="DELETE"
            aria-label="Type DELETE to confirm account deletion"
            autoFocus
            disabled={deleting}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm !bg-[var(--error)] !text-[var(--text-inverse)]"
              disabled={!canConfirm || deleting}
              onClick={handleDelete}
            >
              {deleting ? "Deleting…" : "Permanently delete my account"}
            </button>
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={deleting}
              onClick={() => {
                setOpen(false);
                setConfirmText("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
