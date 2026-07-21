"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { errorFromCaught } from "@/lib/safe-error-message";

interface Disable2FADialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

/** Account-leaf destructive flow — kit Dialog only (Wave 3). */
export function Disable2FADialog({ onClose, onSuccess }: Disable2FADialogProps) {
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
    } catch (err) {
      setError(errorFromCaught(err, "Failed to disable 2FA"));
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
            <label htmlFor="disable-2fa-code" className="sr-only">
              6-digit authenticator code
            </label>
            <input
              id="disable-2fa-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              aria-describedby={error ? "disable-2fa-error" : undefined}
              className="w-full px-3 py-2 text-center text-2xl tracking-widest border border-[var(--border)] rounded-lg bg-[var(--bg-primary)] text-[var(--text-primary)]"
              autoFocus
            />
          </div>

          {error ? (
            <p id="disable-2fa-error" role="alert" className="text-sm text-[var(--error)]">
              {error}
            </p>
          ) : null}

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
