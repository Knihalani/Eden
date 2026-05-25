"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Loader2, Copy, Check, X } from "lucide-react";

interface TwoFASetupDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function TwoFASetupDialog({ onClose, onSuccess }: TwoFASetupDialogProps) {
  const [step, setStep] = useState<"qr" | "verify">("qr");
  const [qrData, setQrData] = useState<{
    secret: string;
    qr_code_base64: string;
    otpauth_url: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadQrCode();
  }, []);

  const loadQrCode = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.setup2FA();
      setQrData(data);
      setStep("qr");
    } catch (e: any) {
      setError(e.message || "Failed to setup 2FA");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.verify2FA(code);
      onSuccess();
    } catch (e: any) {
      setError(e.message || "Invalid code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopySecret = () => {
    if (qrData?.secret) {
      navigator.clipboard.writeText(qrData.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--surface)] rounded-xl p-6 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Set Up Two-Factor Authentication</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-stone-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading && !qrData ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : error && !qrData ? (
          <div className="text-center py-8">
            <p className="text-red-500 mb-4">{error}</p>
            <button
              onClick={loadQrCode}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              Try Again
            </button>
          </div>
        ) : step === "qr" && qrData ? (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Scan this QR code with your authenticator app (like Google Authenticator, Authy, or 1Password).
            </p>

            <div className="flex justify-center py-4">
              <img
                src={`data:image/png;base64,${qrData.qr_code_base64}`}
                alt="2FA QR Code"
                className="w-48 h-48 border border-[var(--border)] rounded-lg"
              />
            </div>

            <div className="p-3 bg-[var(--bg-muted)] rounded-lg">
              <p className="text-xs text-[var(--text-secondary)] mb-2">Manual entry code:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono break-all">{qrData.secret}</code>
                <button
                  onClick={handleCopySecret}
                  className="p-1.5 hover:bg-stone-200 rounded transition-colors"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-sm border border-[var(--border)] rounded-lg hover:bg-stone-50"
              >
                Cancel
              </button>
              <button
                onClick={() => setStep("verify")}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
              >
                I've Scanned It
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              Enter the 6-digit code from your authenticator app to verify setup.
            </p>

            <div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="w-full px-3 py-3 text-center text-2xl tracking-widest border border-[var(--border)] rounded-lg"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-red-500 text-center">{error}</p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep("qr")}
                className="flex-1 px-4 py-2 text-sm border border-[var(--border)] rounded-lg hover:bg-stone-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                ) : (
                  "Verify & Enable"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}