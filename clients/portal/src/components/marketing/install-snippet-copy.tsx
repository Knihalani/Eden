"use client";

import { useCallback, useState } from "react";

/** Client island — clipboard only. */
export function InstallSnippetCopy({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [snippet]);

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="ds-btn ds-btn-ghost ds-btn-sm"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
