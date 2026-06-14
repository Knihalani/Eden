/**
 * 2FA setup dialog — STUB.
 *
 * Real implementation in ``eden-portal-2fa`` is a multi-step
 * TOTP-enrollment wizard (QR code, secret display, verification).
 * The current page imports this stub so type-check passes and the
 * surrounding layout builds.  When the real dialog is added,
 * replace the body of this component — the public
 * ``TwoFASetupDialog`` props (``onClose``, ``onSuccess``) are the
 * same shape the rest of the profile page expects.
 */
"use client";

import { Button } from "@/components/ui/button";

interface TwoFASetupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function TwoFASetupDialog({ onClose, onSuccess }: TwoFASetupDialogProps) {
  return (
    <div className="rounded border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        2FA setup dialog (stub — full TOTP enrollment wizard not yet built).
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSuccess}>Mark enabled</Button>
      </div>
    </div>
  );
}
