"use client";

import Link from "next/link";
import { useState } from "react";
import {
  agentLabel,
  formatFailRate,
  liveVersion,
  previousVersion,
  versionById,
  type PromptDetailTab,
  type PromptEnv,
  type PromptFixture,
  type PromptVersion,
} from "@/lab/fixtures/prompts";
import {
  PromptStatusChip,
  PromptTabNav,
} from "@/lab/prompts/prompts-chrome";
import { AgentLink, EmptyState } from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

export function PromptsDetailView({
  prompt,
  tab,
  versionId,
  draftBody,
  notice,
  onTab,
  onVersion,
  onDraftChange,
  onSaveDraft,
  onPin,
  onRollback,
}: {
  prompt: PromptFixture | null;
  tab: PromptDetailTab;
  versionId: string | null;
  draftBody: string;
  notice: string | null;
  onTab: (t: PromptDetailTab) => void;
  onVersion: (id: string) => void;
  onDraftChange: (body: string) => void;
  onSaveDraft: () => void | Promise<void>;
  onPin: (versionId: string, env: PromptEnv) => void | Promise<void>;
  onRollback: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  if (!prompt) {
    return <EmptyState title="Select a prompt" compact />;
  }

  const selected =
    versionById(prompt, versionId) ??
    liveVersion(prompt) ??
    prompt.versions[0] ??
    null;
  const prior = previousVersion(prompt);
  const dirty = selected ? draftBody !== selected.body : draftBody.length > 0;

  async function run(action: () => void | Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 space-y-2.5 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <PromptStatusChip status={prompt.status} />
              <span className="type-meta text-[var(--text-faint)]">
                {prompt.slug}
              </span>
            </div>
            <h2 className="type-title text-[var(--text)]">{prompt.name}</h2>
            <p className="type-meta">
              <AgentLink
                agentId={prompt.agentId}
                name={agentLabel(prompt.agentId)}
              />
              {prompt.usage24h > 0 ? (
                <>
                  <span className="text-[var(--text-faint)]"> · </span>
                  {prompt.usage24h}/24h
                  <span className="text-[var(--text-faint)]"> · </span>
                  <span
                    className={cn(
                      prompt.failRate >= 0.15 && "text-[var(--error)]",
                    )}
                  >
                    {formatFailRate(prompt.failRate)} fail
                  </span>
                </>
              ) : null}
              <span className="text-[var(--text-faint)]"> · </span>
              prod {prompt.lastDeployed}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={!dirty || busy}
              onClick={() => void run(onSaveDraft)}
            >
              {busy ? "Saving…" : "Save draft"}
            </button>
            {selected ? (
              <button
                type="button"
                className="ds-btn ds-btn-sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    onTab("deploy");
                    await onPin(selected.id, "prod");
                  })
                }
              >
                Deploy to prod
              </button>
            ) : null}
            {prior ? (
              <button
                type="button"
                className="ds-btn ds-btn-ghost ds-btn-sm"
                disabled={busy}
                onClick={() => void run(onRollback)}
              >
                Rollback
              </button>
            ) : null}
          </div>
        </div>

        {notice ? (
          <p className="type-meta text-[var(--accent)]">{notice}</p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <PromptTabNav value={tab} onChange={onTab} />
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/evals?mode=playground&agent=${prompt.agentId}`}
              className="ds-btn ds-btn-ghost ds-btn-sm"
            >
              Playground
            </Link>
            {prompt.improvePlanId ? (
              <Link
                href={`/improve?mode=plan&id=${prompt.improvePlanId}&agent=${prompt.agentId}`}
                className="ds-btn ds-btn-ghost ds-btn-sm"
              >
                Improve plan
              </Link>
            ) : null}
            {prompt.compareExperimentId ? (
              <Link
                href={`/compare?id=${prompt.compareExperimentId}&agent=${prompt.agentId}`}
                className="ds-btn ds-btn-ghost ds-btn-sm"
              >
                Live A/B
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === "editor" ? (
          <EditorPane
            prompt={prompt}
            selected={selected}
            draftBody={draftBody}
            dirty={dirty}
            busy={busy}
            onDraftChange={onDraftChange}
            onSaveDraft={() => void run(onSaveDraft)}
            onVersion={onVersion}
          />
        ) : null}
        {tab === "versions" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <VersionsPane
              prompt={prompt}
              selectedId={selected?.id ?? null}
              onVersion={(id) => {
                onVersion(id);
                onTab("editor");
              }}
            />
          </div>
        ) : null}
        {tab === "deploy" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DeployPane
              prompt={prompt}
              selected={selected}
              prior={prior}
              busy={busy}
              onPin={(vid, env) => void run(() => onPin(vid, env))}
              onRollback={() => void run(onRollback)}
              onVersion={onVersion}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EditorPane({
  prompt,
  selected,
  draftBody,
  dirty,
  busy,
  onDraftChange,
  onSaveDraft,
  onVersion,
}: {
  prompt: PromptFixture;
  selected: PromptVersion | null;
  draftBody: string;
  dirty: boolean;
  busy: boolean;
  onDraftChange: (body: string) => void;
  onSaveDraft: () => void;
  onVersion: (id: string) => void;
}) {
  const live = liveVersion(prompt);
  const showDiff = selected && live && selected.id !== live.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-3 sm:px-5">
        <label className="type-meta flex items-center gap-2">
          Version
          <select
            className="ds-input !h-8 !py-0"
            value={selected?.id ?? ""}
            onChange={(e) => onVersion(e.target.value)}
          >
            {prompt.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.status}
              </option>
            ))}
          </select>
        </label>
        {dirty ? (
          <span className="type-meta text-[var(--accent)]">Unsaved</span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!dirty || busy}
            onClick={onSaveDraft}
          >
            {busy ? "Saving…" : "Save as new draft"}
          </button>
          {selected && dirty ? (
            <button
              type="button"
              className="ds-btn ds-btn-sm"
              onClick={() => onDraftChange(selected.body)}
            >
              Discard changes
            </button>
          ) : null}
        </div>
      </div>

      <textarea
        value={draftBody}
        onChange={(e) => onDraftChange(e.target.value)}
        className="ds-input type-mono min-h-0 w-full flex-1 resize-none !rounded-none !border-0 !px-4 !py-4 !text-[0.875rem] leading-relaxed sm:!px-5"
        aria-label="Prompt body"
        spellCheck={false}
      />

      {showDiff && live ? (
        <section className="max-h-[30vh] shrink-0 space-y-2 overflow-y-auto border-t border-[var(--line)] px-4 py-3 sm:px-5">
          <h3 className="type-label">Diff vs prod ({live.label})</h3>
          <div className="grid gap-2 md:grid-cols-2">
            <BodyBlock label={`Prod · ${live.label}`} body={live.body} />
            <BodyBlock
              label={`Selected · ${selected.label}`}
              body={selected.body}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

function BodyBlock({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--bg-inset)] px-3 py-2">
      <p className="type-label">{label}</p>
      <pre className="type-mono mt-1.5 whitespace-pre-wrap !text-[0.6875rem] text-[var(--text-secondary)]">
        {body}
      </pre>
    </div>
  );
}

function VersionsPane({
  prompt,
  selectedId,
  onVersion,
}: {
  prompt: PromptFixture;
  selectedId: string | null;
  onVersion: (id: string) => void;
}) {
  return (
    <ul className="divide-y divide-[var(--line)]">
      {prompt.versions.map((v) => {
        const pinnedEnvs = (
          Object.entries(prompt.pins) as [PromptEnv, string][]
        )
          .filter(([, id]) => id === v.id)
          .map(([env]) => env);
        const active = v.id === selectedId;
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => onVersion(v.id)}
              className={cn(
                "flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left sm:px-5",
                active
                  ? "bg-[var(--accent-muted)]"
                  : "hover:bg-[var(--bg-inset)]",
              )}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="type-ui text-[var(--text)]">{v.label}</span>
                <PromptStatusChip status={v.status} />
                {pinnedEnvs.map((env) => (
                  <span key={env} className="type-meta text-[var(--accent)]">
                    {env}
                  </span>
                ))}
              </div>
              <span className="type-meta">
                {v.deployedAt ? `deployed ${v.deployedAt}` : v.createdAt}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DeployPane({
  prompt,
  selected,
  prior,
  busy,
  onPin,
  onRollback,
  onVersion,
}: {
  prompt: PromptFixture;
  selected: PromptVersion | null;
  prior: PromptVersion | undefined;
  busy: boolean;
  onPin: (versionId: string, env: PromptEnv) => void;
  onRollback: () => void;
  onVersion: (id: string) => void;
}) {
  const envs: PromptEnv[] = ["dev", "staging", "prod"];

  return (
    <div className="space-y-5 p-4 sm:p-5">
      <section className="space-y-2">
        <h3 className="type-label">Pin version</h3>
        <label className="type-meta flex flex-wrap items-center gap-2">
          Version
          <select
            className="ds-input !h-8 !py-0"
            value={selected?.id ?? ""}
            onChange={(e) => onVersion(e.target.value)}
          >
            {prompt.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.status}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {envs.map((env) => (
            <button
              key={env}
              type="button"
              className={cn(
                "ds-btn ds-btn-sm",
                env === "prod" && "ds-btn-primary",
              )}
              disabled={!selected || busy}
              onClick={() => selected && onPin(selected.id, env)}
            >
              Pin {env}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="type-label">Current pins</h3>
        <dl className="grid gap-2 sm:grid-cols-3">
          {envs.map((env) => {
            const id = prompt.pins[env];
            const v = versionById(prompt, id);
            return (
              <div
                key={env}
                className="rounded-[var(--radius)] bg-[var(--bg-inset)] px-3 py-2"
              >
                <dt className="type-label">{env}</dt>
                <dd className="type-ui mt-1 text-[var(--text)]">
                  {v ? `${v.label} · ${v.status}` : "—"}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {prior ? (
        <section className="space-y-2">
          <h3 className="type-label">Rollback</h3>
          <p className="type-meta text-[var(--text-secondary)]">
            Restore {prior.label} as prod live.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn-sm"
            disabled={busy}
            onClick={onRollback}
          >
            Rollback prod to {prior.label}
          </button>
        </section>
      ) : null}
    </div>
  );
}
