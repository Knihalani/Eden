"use client";

import { useState } from "react";

export function CopyPrompt({ text, onFail }: { text: string; onFail?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      className="ghost"
      data-copied={copied ? "true" : undefined}
      data-fail={failed ? "true" : undefined}
      disabled={!text.trim()}
      aria-live="polite"
      aria-label={failed ? "Clipboard blocked. Select the prompt instead." : copied ? "Copied setup prompt" : "Copy setup prompt"}
      onClick={async () => {
        setFailed(false);
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
          setFailed(true);
          window.setTimeout(() => setFailed(false), 2400);
          onFail?.();
        }
      }}
    >
      {failed ? "Select the prompt" : copied ? "Copied" : "Copy"}
    </button>
  );
}
