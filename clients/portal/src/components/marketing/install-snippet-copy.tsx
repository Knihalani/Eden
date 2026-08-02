"use client";

import { useCallback, useState } from "react";

/** Client island — clipboard only. */
export function InstallSnippetCopy({
  snippet,
  disabled,
}: {
  snippet: string;
  /** Gate copying until the snippet has real credentials filled in. */
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permission denials used to no-op silently — the
      // button just sat there looking broken.
      setCopied(false);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2400);
    }
  }, [snippet]);

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      disabled={disabled}
      className="ds-btn ds-btn-ghost ds-btn-sm"
    >
      {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
    </button>
  );
}
