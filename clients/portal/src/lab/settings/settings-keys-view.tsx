"use client";

import { useMemo, useState } from "react";
import {
  KEY_SCOPE_OPTIONS,
  type ApiKeyFixture,
  type KeyScope,
} from "@/lab/fixtures/settings";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";
import { KeyStatusChip } from "@/lab/settings/settings-chrome";
import { cn } from "@/lib/utils";

type KeyFilter = "all" | "active" | "revoked";

export function SettingsKeysView({
  keys,
  selectedId,
  onSelect,
  onCreate,
  onRevoke,
  onDismissSecret,
}: {
  keys: ApiKeyFixture[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, scopes: KeyScope[]) => Promise<ApiKeyFixture>;
  onRevoke: (id: string) => Promise<void>;
  onDismissSecret: (id: string) => void;
}) {
  const { pushToast } = useLabToast();
  const [draftName, setDraftName] = useState("");
  const [scopes, setScopes] = useState<KeyScope[]>(["ingest"]);
  const [filter, setFilter] = useState<KeyFilter>("all");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    if (filter === "all") return keys;
    return keys.filter((k) => k.status === filter);
  }, [keys, filter]);

  const selected =
    filtered.find((k) => k.id === selectedId) ??
    keys.find((k) => k.id === selectedId) ??
    filtered[0] ??
    null;

  const counts = {
    all: keys.length,
    active: keys.filter((k) => k.status === "active").length,
    revoked: keys.filter((k) => k.status === "revoked").length,
  };

  function toggleScope(scope: KeyScope) {
    setScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((s) => s !== scope)
        : [...prev, scope],
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
        <div className="shrink-0 space-y-3 border-b border-[var(--line)] px-4 py-3 sm:px-6">
          <FilterChips
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All", count: counts.all },
              { id: "active", label: "Active", count: counts.active },
              { id: "revoked", label: "Revoked", count: counts.revoked },
            ]}
          />
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1">
              <span className="type-label">New key</span>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Name (e.g. Staging ingest)"
                className="ds-input mt-1.5 w-full"
                aria-label="API key name"
              />
            </label>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={!draftName.trim() || scopes.length === 0}
              onClick={async () => {
                try {
                  const created = await onCreate(draftName.trim(), scopes);
                  setDraftName("");
                  setScopes(["ingest"]);
                  setFilter("all");
                  onSelect(created.id);
                  pushToast({
                    title: "API key created",
                    body: "Copy the secret now — it won’t show again.",
                    tone: "ok",
                  });
                } catch (err) {
                  pushToast({
                    title: "Create failed",
                    body: err instanceof Error ? err.message : "Try again.",
                    tone: "fail",
                  });
                }
              }}
            >
              Create
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {KEY_SCOPE_OPTIONS.map((opt) => {
              const on = scopes.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  className="ds-tab"
                  data-active={on ? "true" : "false"}
                  aria-pressed={on}
                  onClick={() => toggleScope(opt.id)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            compact
            title={keys.length === 0 ? "No API keys" : "No matches"}
            body={
              keys.length === 0
                ? "Create a key so agents can ingest."
                : "Try another filter."
            }
            action={
              filter !== "all" ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => setFilter("all")}
                >
                  Clear filter
                </button>
              ) : undefined
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {filtered.map((k) => {
              const active = k.id === selected?.id;
              return (
                <li key={k.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmRevoke(false);
                      setCopied(false);
                      onSelect(k.id);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                      active && "bg-[var(--accent-muted)]",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <KeyStatusChip status={k.status} />
                      <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                        {k.name}
                      </span>
                      <span className="type-mono !text-[0.6875rem]">
                        {k.prefix}…
                      </span>
                    </div>
                    <p className="type-meta">
                      {k.scopes.join(" · ")}
                      <span className="mx-1.5 text-[var(--text-faint)]">·</span>
                      last used {k.lastUsed ?? "never"}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex min-h-[14rem] w-full shrink-0 flex-col lg:w-[26rem] lg:min-h-0">
        {selected ? (
          <div className="flex h-full flex-col border-t border-[var(--line)] bg-[var(--bg-inset)] px-4 py-4 sm:px-6 lg:border-t-0">
            <div className="flex flex-wrap items-center gap-2">
              <KeyStatusChip status={selected.status} />
              <span className="type-mono !text-[0.6875rem]">
                {selected.prefix}…
              </span>
            </div>
            <h2 className="type-ui mt-3 text-[var(--text)]">{selected.name}</h2>
            <p className="type-meta mt-1">
              Created {selected.createdAt} by {selected.createdBy}
            </p>

            {selected.secret ? (
              <div className="mt-4 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg)] p-3">
                <p className="type-label text-[var(--error)]">
                  Secret — copy now
                </p>
                <p className="type-mono mt-2 break-all !text-[0.75rem] text-[var(--text)]">
                  {selected.secret}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ds-btn ds-btn-primary ds-btn-sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(selected.secret!);
                        setCopied(true);
                        pushToast({
                          title: "Secret copied",
                          tone: "ok",
                        });
                      } catch {
                        pushToast({
                          title: "Copy failed",
                          body: "Select the secret and copy manually.",
                          tone: "fail",
                        });
                      }
                    }}
                  >
                    {copied ? "Copied" : "Copy secret"}
                  </button>
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={() => {
                      onDismissSecret(selected.id);
                      setCopied(false);
                    }}
                  >
                    I’ve saved it
                  </button>
                </div>
              </div>
            ) : null}

            <dl className="mt-4 space-y-3">
              <div>
                <dt className="type-label">Scopes</dt>
                <dd className="type-body mt-1 text-[var(--text-secondary)]">
                  {selected.scopes.join(", ")}
                </dd>
              </div>
              <div>
                <dt className="type-label">Last used</dt>
                <dd className="type-body mt-1 text-[var(--text-secondary)]">
                  {selected.lastUsed ?? "never"}
                </dd>
              </div>
            </dl>

            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              {selected.status === "active" ? (
                confirmRevoke ? (
                  <>
                    <button
                      type="button"
                      className="ds-btn ds-btn-primary ds-btn-sm !bg-[var(--error)] !text-[var(--text-inverse)]"
                      onClick={() => {
                        const id = selected.id;
                        const name = selected.name;
                        setConfirmRevoke(false);
                        void onRevoke(id)
                          .then(() => {
                            pushToast({
                              title: "API key revoked",
                              body: name,
                              tone: "fail",
                            });
                          })
                          .catch(() => {
                            /* parent already toasted failure */
                          });
                      }}
                    >
                      Confirm revoke
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      onClick={() => setConfirmRevoke(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm !text-[var(--error)]"
                    onClick={() => setConfirmRevoke(true)}
                  >
                    Revoke
                  </button>
                )
              ) : (
                <p className="type-meta">This key is revoked.</p>
              )}
            </div>
          </div>
        ) : (
          <EmptyState compact title="Select a key" />
        )}
      </div>
    </div>
  );
}
