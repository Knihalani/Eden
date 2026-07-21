"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { API_HOST } from "./api-keys-scopes";

export type ApiKeysSdkCredentialsProps = {
  orgId: string;
  copied: string | null;
  onCopy: (label: string, text: string) => void;
};

export function ApiKeysSdkCredentials({
  orgId,
  copied,
  onCopy,
}: ApiKeysSdkCredentialsProps) {
  return (
    <SettingsCard>
      <div className="space-y-space-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            SDK credentials
          </h3>
          <p className="mt-1 text-sm text-[var(--text-secondary)] leading-relaxed">
            Set <code className="text-xs font-mono">EDEN_API_KEY</code> and{" "}
            <code className="text-xs font-mono">EDEN_ORG_ID</code>, then follow the{" "}
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              docs quickstart
            </a>
            {" "}
            (use <span className="font-medium text-[var(--text-primary)]">Fill in</span> when
            signed in). SDKs default to{" "}
            <code className="text-xs font-mono">{API_HOST}</code>.
          </p>
        </div>

        <div className="rounded-lg bg-[var(--bg-secondary)] p-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                EDEN_ORG_ID
              </p>
              <code className="mt-0.5 block truncate text-sm font-mono text-[var(--text-primary)]">
                {orgId}
              </code>
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() => void onCopy("EDEN_ORG_ID", orgId)}
              aria-label="Copy EDEN_ORG_ID"
            >
              {copied === "EDEN_ORG_ID" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied === "EDEN_ORG_ID" ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="flex flex-col gap-2 border-t border-[var(--border-default)] pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Shell export
              </p>
              <code className="mt-0.5 block break-all text-xs font-mono text-[var(--text-primary)]">
                export EDEN_ORG_ID=&quot;{orgId}&quot;
              </code>
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() =>
                void onCopy("org export", `export EDEN_ORG_ID="${orgId}"`)
              }
              aria-label="Copy EDEN_ORG_ID export"
            >
              {copied === "org export" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied === "org export" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        <a
          href={DOCS_QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
        >
          Open docs quickstart
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </SettingsCard>
  );
}
