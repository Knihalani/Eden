"use client";

/**
 * Create + reveal-once secret panel for API keys (Wave 5).
 * One primary CTA: Create API key. Secret shown once after create.
 */

import { Check, Copy, ExternalLink, Loader2, Plus } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import {
  ALL_SCOPES,
  MCP_DEFAULT_SCOPES,
  SDK_DEFAULT_SCOPES,
} from "./api-keys-scopes";

export type ApiKeysCreatePanelProps = {
  orgId: string;
  showCreate: boolean;
  creating: boolean;
  newKeyName: string;
  selectedScopes: string[];
  createdKey: string | null;
  copied: string | null;
  onOpenCreate: () => void;
  onNameChange: (name: string) => void;
  onScopesChange: (scopes: string[]) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onDismissSecret: () => void;
  onCopy: (label: string, text: string) => void;
};

export function ApiKeysCreatePanel({
  orgId,
  showCreate,
  creating,
  newKeyName,
  selectedScopes,
  createdKey,
  copied,
  onOpenCreate,
  onNameChange,
  onScopesChange,
  onCreate,
  onCancelCreate,
  onDismissSecret,
  onCopy,
}: ApiKeysCreatePanelProps) {
  return (
    <SettingsCard
      title="Create API key"
      description="Primary job — SDK presets include ingest so traces land."
    >
      {!showCreate && !createdKey && (
        <Button
          type="button"
          className="min-h-11"
          onClick={onOpenCreate}
          data-ws5-keys-create
        >
          <Plus className="w-4 h-4" />
          Create API key
        </Button>
      )}

      {showCreate && (
        <div className="space-y-space-4">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Create new API key
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            SDK presets include ingest. The secret is shown once after create — copy it
            immediately.
          </p>
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Key name (e.g., SDK, production)"
            aria-label="Key name"
            className="w-full min-h-11 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
          />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)] mb-2">
              Permissions
            </p>
            <div className="mb-2 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="link"
                className="min-h-11 px-2"
                onClick={() => onScopesChange(SDK_DEFAULT_SCOPES)}
              >
                SDK presets
              </Button>
              <Button
                type="button"
                variant="link"
                className="min-h-11 px-2"
                onClick={() => {
                  onNameChange("MCP");
                  onScopesChange(MCP_DEFAULT_SCOPES);
                }}
              >
                MCP presets
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ALL_SCOPES.map((scope) => (
                <label
                  key={scope.id}
                  className="flex min-h-11 items-center gap-2 rounded-md bg-[var(--bg-secondary)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--bg-tertiary)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope.id)}
                    onChange={(e) => {
                      onScopesChange(
                        e.target.checked
                          ? [...selectedScopes, scope.id]
                          : selectedScopes.filter((s) => s !== scope.id),
                      );
                    }}
                  />
                  {scope.label}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              onClick={() => void onCreate()}
              disabled={creating || !newKeyName.trim() || selectedScopes.length === 0}
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={onCancelCreate}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {createdKey && (
        <div
          className="space-y-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-4"
          role="status"
          aria-live="polite"
          data-ws5-keys-secret
        >
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Copy this secret now — shown once
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            Paste into your shell, or use{" "}
            <span className="font-medium text-[var(--text-primary)]">Fill in</span> on the{" "}
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent)] hover:underline"
            >
              docs quickstart
            </a>
            . Closing this panel hides the key permanently.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-md bg-[var(--bg-secondary)] px-3 py-2 text-xs font-mono">
              {createdKey}
            </code>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() => void onCopy("EDEN_API_KEY", createdKey)}
              aria-label="Copy API key"
            >
              {copied === "EDEN_API_KEY" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied === "EDEN_API_KEY" ? "Copied" : "Copy key"}
            </Button>
          </div>
          <div className="rounded-md bg-[var(--bg-secondary)] p-3">
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Shell exports
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0"
                onClick={() =>
                  void onCopy(
                    "env exports",
                    `export EDEN_API_KEY="${createdKey}"\nexport EDEN_ORG_ID="${orgId}"`,
                  )
                }
                aria-label="Copy EDEN_API_KEY and EDEN_ORG_ID exports"
              >
                {copied === "env exports" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied === "env exports" ? "Copied" : "Copy both"}
              </Button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs font-mono text-[var(--text-primary)]">{`export EDEN_API_KEY="${createdKey}"
export EDEN_ORG_ID="${orgId}"`}</pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onDismissSecret}
            >
              Done
            </Button>
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-sm text-[var(--accent)] hover:bg-[var(--bg-secondary)]"
            >
              Docs quickstart
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
