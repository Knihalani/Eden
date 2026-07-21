"use client";

import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { api } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2, Copy, Check, ShieldCheck, AlertTriangle, KeyRound } from "lucide-react";

interface TwoFASetupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

const CODE_LENGTH = 6;

export function TwoFASetupDialog({ onClose, onSuccess }: TwoFASetupDialogProps) {
  const [step, setStep] = useState<"qr" | "verify" | "success">("qr");
  const [qrData, setQrData] = useState<{
    secret: string;
    qr_code_base64: string;
    otpauth_url: string;
  } | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    void loadQrCode();
  }, []);

  const loadQrCode = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.setup2FA();
      setQrData(data);
      setStep("qr");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Failed to setup 2FA");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const code = digits.join("");
    if (code.length !== CODE_LENGTH) return;
    setError("");
    setLoading(true);
    try {
      await api.verify2FA(code);
      setStep("success");
      setTimeout(() => onSuccess(), 1200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e.message || "Invalid code. Please try again.");
      setDigits(Array(CODE_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleCopySecret = () => {
    if (qrData?.secret) {
      void navigator.clipboard.writeText(qrData.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDigitChange = (index: number, e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, "");
    if (val.length > 1) {
      const chars = val.slice(0, CODE_LENGTH - index).split("");
      const newDigits = [...digits];
      chars.forEach((c, i) => {
        if (index + i < CODE_LENGTH) newDigits[index + i] = c;
      });
      setDigits(newDigits);
      const nextIndex = Math.min(index + chars.length, CODE_LENGTH - 1);
      inputRefs.current[nextIndex]?.focus();
    } else {
      const newDigits = [...digits];
      newDigits[index] = val;
      setDigits(newDigits);
      if (val && index < CODE_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus();
      }
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === "Enter") {
      void handleVerify();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, CODE_LENGTH);
    if (!pasted) return;
    const newDigits = Array(CODE_LENGTH).fill("");
    pasted.split("").forEach((c, i) => {
      newDigits[i] = c;
    });
    setDigits(newDigits);
    const lastFilled = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[lastFilled]?.focus();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-ws4-security-setup>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[var(--accent)]" aria-hidden />
            Set Up Two-Factor Authentication
          </DialogTitle>
          <DialogDescription>
            Add an extra layer of security to your account with a time-based one-time password.
          </DialogDescription>
        </DialogHeader>

        {loading && !qrData ? (
          <div className="flex flex-col items-center justify-center py-10 space-y-3">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--text-muted)]" aria-hidden />
            <p className="text-sm text-[var(--text-muted)]">Generating secret…</p>
          </div>
        ) : error && !qrData ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-3">
            <div className="p-2 rounded-full bg-[var(--error-dim)]">
              <AlertTriangle className="w-6 h-6 text-[var(--error)]" aria-hidden />
            </div>
            <p className="text-sm text-[var(--error)] text-center max-w-xs">{error}</p>
            <Button onClick={() => void loadQrCode()} variant="outline">
              Try again
            </Button>
          </div>
        ) : step === "qr" && qrData ? (
          <div className="space-y-space-4">
            <div className="flex flex-col items-center space-y-3">
              <div className="p-3 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-xl">
                {/* next/image doesn't support data: URLs — use plain <img> for the inline QR */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:image/png;base64,${qrData.qr_code_base64}`}
                  alt="2FA QR code — scan with your authenticator app"
                  width={192}
                  height={192}
                  className="h-48 w-48"
                />
              </div>
              <p className="text-xs text-[var(--text-muted)] text-center max-w-xs">
                Scan with Google Authenticator, Authy, 1Password, or any TOTP app.
              </p>
            </div>

            <div className="p-3 bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg">
              <div className="flex items-center gap-2 mb-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden />
                <p className="text-xs text-[var(--text-muted)] font-medium">
                  Can&apos;t scan? Enter manually:
                </p>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono break-all text-[var(--terminal)]">
                  {qrData.secret}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleCopySecret}
                  aria-label={copied ? "Secret copied" : "Copy secret to clipboard"}
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-[var(--terminal)]" aria-hidden />
                  ) : (
                    <Copy className="w-4 h-4 text-[var(--text-muted)]" aria-hidden />
                  )}
                </Button>
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setStep("verify");
                  setTimeout(() => inputRefs.current[0]?.focus(), 100);
                }}
              >
                I&apos;ve scanned it
              </Button>
            </DialogFooter>
          </div>
        ) : step === "verify" ? (
          <form onSubmit={(e) => void handleVerify(e)} className="space-y-space-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Enter the 6-digit code from your authenticator app.
            </p>

            <div className="flex justify-center gap-2" onPaste={handlePaste}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputRefs.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  value={d}
                  onChange={(e) => handleDigitChange(i, e)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  aria-label={`Digit ${i + 1} of 6`}
                  maxLength={1}
                  className={cn(
                    "w-12 h-14 text-center text-2xl font-mono font-semibold",
                    "bg-[var(--bg-base)] border border-[var(--border-default)] rounded-lg",
                    "focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-faint)]",
                    "transition-colors",
                    error &&
                      "border-[var(--error)] focus:border-[var(--error)] focus:ring-[var(--error-dim)]",
                  )}
                />
              ))}
            </div>

            {error && (
              <p
                role="alert"
                className="text-sm text-[var(--error)] text-center flex items-center justify-center gap-1.5"
              >
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                {error}
              </p>
            )}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setStep("qr")}>
                Back
              </Button>
              <Button
                type="submit"
                disabled={loading || digits.join("").length !== CODE_LENGTH}
                loading={loading}
              >
                Verify & Enable
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 space-y-3">
            <div className="p-3 rounded-full bg-[var(--terminal-faint)]">
              <Check className="w-8 h-8 text-[var(--terminal)]" aria-hidden />
            </div>
            <p className="text-lg font-semibold text-[var(--text-primary)]">2FA enabled</p>
            <p className="text-sm text-[var(--text-secondary)] text-center max-w-xs">
              Two-factor authentication is now active on your account.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
