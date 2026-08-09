"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import {
  api,
  type AccountDeleteResponse,
  type StoreErasureStatus,
} from "@/lib/api/resources";
import { StatusChip } from "@/components/ds/primitives";
import { useLabToast } from "@/lab/lab-toast";

const CONFIRM_PHRASE = "DELETE";
const SIGN_OUT_DELAY_MS = 4000;

function formatStoreLabel(store: string): string {
  if (store === "postgres") return "Postgres";
  return store.charAt(0).toUpperCase() + store.slice(1);
}

function formatErasureStatus(status: string): string {
  switch (status) {
    case "ok":
      return "erased";
    case "failed":
      return "failed";
    case "unsupported":
      return "not yet supported";
    case "unavailable":
      return "unavailable";
    case "dry_run":
      return "dry run";
    default:
      return status;
  }
}

function statusChipTone(status: string): "ok" | "fail" | "neutral" {
  if (status === "ok") return "ok";
  if (status === "failed" || status === "unavailable") return "fail";
  return "neutral";
}

function erasureToastTone(
  statuses: StoreErasureStatus[],
): "ok" | "fail" | "default" {
  if (statuses.some((s) => s.status === "failed" || s.status === "unavailable")) {
    return "fail";
  }
  if (statuses.every((s) => s.status === "ok")) return "ok";
  return "default";
}

function ErasureStatusList({ statuses }: { statuses: StoreErasureStatus[] }) {
  return (
    <ul className="mt-3 space-y-1.5" aria-label="Per-store erasure status">
      {statuses.map((entry) => (
        <li
          key={`${entry.store}-${entry.org_id ?? "all"}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 type-meta text-[var(--text)]"
        >
          <span className="font-medium">{formatStoreLabel(entry.store)}:</span>
          <StatusChip tone={statusChipTone(entry.status)}>
            {formatErasureStatus(entry.status)}
          </StatusChip>
          {entry.detail ? (
            <span className="text-[var(--text-muted)]">({entry.detail})</span>
          ) : null}
          {entry.org_id ? (
            <span className="text-[var(--text-muted)]">· {entry.org_id}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Self-service "Delete my account" — GDPR Art. 17 (right to erasure).
 *
 * Calls the single real erasure code path (``DELETE /auth/users/me`` ->
 * ``eden.services.compliance_jobs.erase_user_account``), which runs a
 * RightToBeForgottenService pass (Postgres anonymisation +
 * cross-store fanout) per org the caller belongs to, then anonymises
 * the account itself and rotates the session token. Coverage is partial
 * and self-reported per store — not a certified GDPR-compliant guarantee.
 * Irreversible, so this requires the caller to type the confirmation
 * phrase before the destructive button becomes clickable.
 */
export function AccountDangerZoneCard() {
  const { pushToast } = useLabToast();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [erasureResult, setErasureResult] = useState<AccountDeleteResponse | null>(
    null,
  );

  const canConfirm = confirmText.trim() === CONFIRM_PHRASE;

  const handleDelete = () => {
    if (!canConfirm || deleting) return;
    setDeleting(true);
    void (async () => {
      try {
        const result = await api.deleteAccount(CONFIRM_PHRASE);
        setErasureResult(result);
        setDeleting(false);
        const statuses = result.store_statuses ?? [];
        pushToast({
          title: "Account erasure complete",
          body:
            statuses.length > 0
              ? "Per-store status below — signing you out shortly."
              : "Signing you out…",
          tone: erasureToastTone(statuses),
        });
        window.setTimeout(() => {
          void signOut({ redirectUrl: "/" });
        }, SIGN_OUT_DELAY_MS);
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
        Deleting your account starts a partial erasure request: your profile
        is anonymised, API sessions are revoked, and data you own is scrubbed
        across every workspace you belong to — with per-store status reported
        honestly (some secondary stores are not fully covered yet). This cannot
        be undone and is not a certified GDPR-compliant guarantee.
      </p>

      {erasureResult ? (
        <div className="max-w-md rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] p-3.5">
          <p className="type-ui text-[var(--text)]">Erasure status by store</p>
          <p className="type-meta mt-1 text-[var(--text-muted)]">
            Coverage varies — not every secondary store supports per-user
            erasure yet.
          </p>
          <ErasureStatusList statuses={erasureResult.store_statuses} />
          <p className="type-meta mt-3 text-[var(--text-muted)]">
            Signing you out in a few seconds…
          </p>
        </div>
      ) : !open ? (
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
