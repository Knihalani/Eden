"use client";

import Link from "next/link";
import {
  ArrowLeftRight,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react";

import { PromptEnvironmentsPanel } from "@/components/prompts/PromptEnvironmentsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";
import { promptPlaygroundHref } from "@/lib/portal-cross-links";
import {
  buildTemplateDiff,
  summarizeTemplateDiff,
} from "./prompt-diff";
import {
  derivePromptLifecycle,
  LIFECYCLE_HONESTY,
  LIFECYCLE_LABELS,
  type PromptLifecycleState,
} from "./prompt-lifecycle";

export interface PromptEditorEntry {
  id: string;
  name: string;
  description: string | null;
}

export interface PromptVersionEntry {
  id: string;
  version: number;
  template: string;
  template_hash: string;
  model: string;
  change_note: string | null;
  created_at: string;
}

interface PromptsEditorProps {
  orgId: string | undefined;
  prompt: PromptEditorEntry | null;
  versions: PromptVersionEntry[];
  versionsLoading: boolean;
  versionsError: string | null;
  expandedDiff: string | null;
  onExpandedDiff: (key: string | null) => void;
  draftTemplate: string;
  draftModel: string;
  draftNote: string;
  versionDirty: boolean;
  savingVersion: boolean;
  envPinCount: number;
  onEnvPinsChange: (count: number) => void;
  onDraftTemplate: (v: string) => void;
  onDraftModel: (v: string) => void;
  onDraftNote: (v: string) => void;
  onMarkDirty: () => void;
  onClose: () => void;
  onRetryVersions: () => void;
  onSaveVersion: () => void;
  onRollbackPin?: (version: number) => void;
  rollbackBusy?: boolean;
}

function LifecycleBadge({ state }: { state: PromptLifecycleState }) {
  const variant =
    state === "draft" ? "secondary" : state === "env_pinned" ? "success" : "outline";
  return (
    <Badge variant={variant} data-testid="prompt-lifecycle-badge" data-lifecycle={state}>
      {LIFECYCLE_LABELS[state]}
    </Badge>
  );
}

export function PromptsEditor({
  orgId,
  prompt,
  versions,
  versionsLoading,
  versionsError,
  expandedDiff,
  onExpandedDiff,
  draftTemplate,
  draftModel,
  draftNote,
  versionDirty,
  savingVersion,
  envPinCount,
  onEnvPinsChange,
  onDraftTemplate,
  onDraftModel,
  onDraftNote,
  onMarkDirty,
  onClose,
  onRetryVersions,
  onSaveVersion,
  onRollbackPin,
  rollbackBusy,
}: PromptsEditorProps) {
  if (!prompt) {
    return (
      <div data-testid="prompts-editor-pane" className="p-space-4">
        <EmptyState
          icon={FileText}
          title="Select a prompt"
          description="Pick a prompt from the list to view versions and edit the template."
          size="sm"
        />
      </div>
    );
  }

  const v = versions;
  const name = prompt.name;
  const lifecycle = derivePromptLifecycle({
    versionCount: v.length,
    envPinCount,
    versionDirty,
  });
  const playgroundHref = promptPlaygroundHref(name);
  const canPublish = versionDirty || v.length === 0;
  const priorVersion = v.length >= 2 ? v[1]?.version : undefined;

  return (
    <div data-testid="prompts-editor-pane" data-wave5-lifecycle={lifecycle}>
      <div className="border-b border-[var(--border-subtle)] px-space-4 py-space-3 space-y-space-3">
        <div className="flex flex-wrap items-center gap-space-2">
          <LifecycleBadge state={lifecycle} />
          <span className="text-xs text-[var(--text-muted)]">
            Draft → playground → publish → env pin
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-space-2">
          <Button asChild size="sm" variant="outline" data-testid="prompts-open-playground">
            <Link href={playgroundHref}>
              <FlaskConical className="h-4 w-4" />
              Open in Playground
            </Link>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSaveVersion}
            loading={savingVersion}
            disabled={savingVersion || !draftTemplate.trim() || !canPublish}
            title={LIFECYCLE_HONESTY.publish}
            data-testid="prompts-publish-version"
          >
            <Save className="h-4 w-4" />
            {v.length === 0 ? "Publish v1" : "Publish version"}
          </Button>
          {priorVersion != null && onRollbackPin ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={rollbackBusy}
              loading={rollbackBusy}
              onClick={() => onRollbackPin(priorVersion)}
              title={LIFECYCLE_HONESTY.rollback}
              data-testid="prompts-rollback"
            >
              <RotateCcw className="h-4 w-4" />
              Rollback to v{priorVersion}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close editor"
            className="ml-auto"
          >
            Close
          </Button>
        </div>
        <p className="text-xs text-[var(--text-muted)]" data-testid="prompts-lifecycle-honesty">
          {LIFECYCLE_HONESTY.publish} {LIFECYCLE_HONESTY.rollback}
        </p>
        <nav
          className="flex flex-wrap gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
          aria-label="Improve scent"
          data-testid="prompts-improve-scent"
        >
          <Link
            href="/improve?tab=plans"
            className="text-[var(--accent)] hover:underline"
          >
            prompt_update plans
          </Link>
          <Link href="/improve" className="hover:underline">
            Improve queue
          </Link>
        </nav>
      </div>

      <div className="bg-[var(--bg-inset)] p-space-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
          <History className="h-3 w-3" />
          Version timeline ({v.length})
        </div>
        {versionsLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : versionsError && v.length === 0 ? (
          <ErrorState
            size="sm"
            title="Could not load prompt versions"
            message={versionsError}
            action={
              <Button size="sm" variant="outline" onClick={onRetryVersions}>
                Try again
              </Button>
            }
          />
        ) : (
          <>
            {v.length === 0 ? (
              <div className="mb-3 text-xs text-[var(--text-muted)]">
                No versions yet — publish a template below to create v1.
              </div>
            ) : (
              <div className="space-y-2" data-testid="prompts-version-table">
                {v.map((ver, idx) => {
                  const prev = idx < v.length - 1 ? v[idx + 1] : null;
                  const diffKey = `${name}:v${ver.version}`;
                  const diffStats = prev
                    ? summarizeTemplateDiff(prev.template, ver.template)
                    : null;
                  const showDiff = expandedDiff === diffKey;
                  return (
                    <Panel key={ver.id} tone="subtle" padding="sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <GitBranch className="h-3 w-3 text-[var(--text-muted)]" />
                          <span className="text-sm font-medium text-[var(--text-primary)]">
                            v{ver.version}
                          </span>
                          <span className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]">
                            {ver.model}
                          </span>
                          <code className="text-xs text-[var(--text-muted)]">
                            {ver.template_hash.slice(0, 12)}
                          </code>
                        </div>
                        <div className="flex items-center gap-3">
                          {diffStats ? (
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              onClick={() =>
                                onExpandedDiff(showDiff ? null : diffKey)
                              }
                              className="h-auto gap-1.5 p-0 text-xs"
                              aria-expanded={showDiff}
                            >
                              <ArrowLeftRight className="h-3 w-3" />
                              {diffStats.added > 0 ? (
                                <span className="text-[var(--terminal)]">
                                  +{diffStats.added}
                                </span>
                              ) : null}
                              {diffStats.removed > 0 ? (
                                <span className="text-[var(--error)]">
                                  -{diffStats.removed}
                                </span>
                              ) : null}
                              {diffStats.added === 0 && diffStats.removed === 0 ? (
                                <span className="text-[var(--text-muted)]">no changes</span>
                              ) : null}
                            </Button>
                          ) : null}
                          {idx > 0 && onRollbackPin ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-auto px-1.5 text-xs"
                              disabled={rollbackBusy}
                              onClick={() => onRollbackPin(ver.version)}
                              title={LIFECYCLE_HONESTY.rollback}
                            >
                              Pin
                            </Button>
                          ) : null}
                          <div className="text-xs text-[var(--text-muted)]">
                            {new Date(ver.created_at).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      {showDiff && prev ? (
                        <div className="mt-3 overflow-hidden rounded-md font-mono text-xs ring-1 ring-inset ring-[var(--border-subtle)]">
                          {buildTemplateDiff(prev.template, ver.template).map((line, li) => (
                            <div
                              key={li}
                              className={
                                line.type === "added"
                                  ? "bg-[var(--terminal)]/5 px-3 py-0.5 text-[var(--terminal)]"
                                  : line.type === "removed"
                                    ? "bg-[var(--error)]/5 px-3 py-0.5 text-[var(--error)]"
                                    : "px-3 py-0.5 text-[var(--text-muted)]"
                              }
                            >
                              <span className="inline-block w-4 select-none">
                                {line.type === "added"
                                  ? "+"
                                  : line.type === "removed"
                                    ? "-"
                                    : " "}
                              </span>
                              {line.content || " "}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <pre className="mt-2 max-h-32 overflow-auto rounded bg-[var(--bg-base)] p-2 text-xs text-[var(--text-primary)]">
                        {ver.template}
                      </pre>
                      {ver.change_note ? (
                        <div className="mt-2 text-xs text-[var(--text-muted)]">
                          Note: {ver.change_note}
                        </div>
                      ) : null}
                    </Panel>
                  );
                })}
              </div>
            )}

            <Panel tone="flat" padding="md" className="mt-3 space-y-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {v.length === 0 ? "Create first version" : "Edit draft"}
                {versionDirty ? (
                  <span className="ml-2 text-xs font-normal text-[var(--warning)]">
                    Unsaved changes
                  </span>
                ) : null}
              </h3>
              <Textarea
                value={draftTemplate}
                onChange={(e) => {
                  onDraftTemplate(e.target.value);
                  onMarkDirty();
                }}
                placeholder="Prompt template (supports {{variables}})"
                rows={6}
                className="bg-[var(--bg-inset)] font-mono text-xs"
                aria-label={`Draft template for ${name}`}
                disabled={savingVersion}
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  type="text"
                  value={draftModel}
                  onChange={(e) => {
                    onDraftModel(e.target.value);
                    onMarkDirty();
                  }}
                  placeholder="Model (e.g. gpt-4o)"
                  className="bg-[var(--bg-inset)]"
                  aria-label={`Model for ${name}`}
                  disabled={savingVersion}
                />
                <Input
                  type="text"
                  value={draftNote}
                  onChange={(e) => {
                    onDraftNote(e.target.value);
                    onMarkDirty();
                  }}
                  placeholder="Change note (optional)"
                  className="bg-[var(--bg-inset)]"
                  aria-label={`Change note for ${name}`}
                  disabled={savingVersion}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={onSaveVersion}
                  loading={savingVersion}
                  disabled={savingVersion || !draftTemplate.trim()}
                >
                  <Save className="h-4 w-4" />
                  Save version
                </Button>
              </div>
            </Panel>
          </>
        )}
        {orgId ? (
          <details
            className="group mt-space-4 border-t border-[var(--border-subtle)] pt-space-4"
            data-testid="prompts-environments"
            open={lifecycle === "env_pinned" || lifecycle === "published"}
          >
            <summary className="cursor-pointer list-none text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
              Environments
              <span className="ml-space-2 text-xs font-normal text-[var(--text-muted)] group-open:hidden">
                Deploy / rollback pins
              </span>
            </summary>
            <div className="mt-space-3">
              <PromptEnvironmentsPanel
                orgId={orgId}
                promptName={name}
                latestVersion={v[0]?.version}
                onPinsChange={onEnvPinsChange}
              />
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
