"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { catalogAgents } from "@/lib/portal-catalog";
import {
  eventActionFamily,
  packsForAgent,
  type AuditEventFixture,
  type AuditPackFixture,
} from "@/lab/fixtures/settings";
import { EmptyState, FilterChips } from "@/lab/lab-ui";
import {
  AuditTabNav,
  PackKindChip,
  VerifyChip,
  type AuditTab,
} from "@/lab/settings/settings-chrome";
import { AuditChainTrustSignal } from "@/lab/settings/audit-chain-trust-signal";
import { cn } from "@/lib/utils";

type EventFilter = "all" | "keys" | "members" | "ops" | "workspace" | "other";

export function SettingsAuditView({
  tab,
  onTab,
  agentId,
  onAgent,
  events,
  packs,
  selectedPackId,
  onSelectPack,
}: {
  tab: AuditTab;
  onTab: (tab: AuditTab) => void;
  agentId: string;
  onAgent: (id: string) => void;
  events: AuditEventFixture[];
  packs: AuditPackFixture[];
  selectedPackId: string | null;
  onSelectPack: (id: string) => void;
}) {
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");

  const filteredEvents = useMemo(() => {
    if (eventFilter === "all") return events;
    return events.filter((e) => eventActionFamily(e.action) === eventFilter);
  }, [events, eventFilter]);

  const rows = useMemo(() => packsForAgent(agentId, packs), [agentId, packs]);
  const selected =
    rows.find((p) => p.id === selectedPackId) ?? rows[0] ?? null;

  const eventCounts = useMemo(() => {
    const base: Record<EventFilter, number> = {
      all: events.length,
      keys: 0,
      members: 0,
      ops: 0,
      workspace: 0,
      other: 0,
    };
    for (const e of events) {
      const fam = eventActionFamily(e.action) as Exclude<EventFilter, "all">;
      base[fam] += 1;
    }
    return base;
  }, [events]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <AuditTabNav value={tab} onChange={onTab} />
          <AuditChainTrustSignal />
        </div>
        {tab === "packs" ? (
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Agent</span>
            <select
              className="ds-input !h-8 !w-auto max-w-[10rem] !py-0 !text-[0.75rem]"
              value={agentId}
              onChange={(e) => onAgent(e.target.value)}
              aria-label="Filter packs by agent"
            >
              <option value="all">All agents ({packs.length})</option>
              {catalogAgents().map((a) => {
                const n = packs.filter((p) => p.agentId === a.id).length;
                return (
                  <option key={a.id} value={a.id}>
                    {a.name} ({n})
                  </option>
                );
              })}
            </select>
          </label>
        ) : null}
      </div>

      {tab === "events" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--line)] px-4 py-2.5 sm:px-6">
            <FilterChips
              value={eventFilter}
              onChange={setEventFilter}
              options={[
                { id: "all", label: "All", count: eventCounts.all },
                { id: "keys", label: "Keys", count: eventCounts.keys },
                { id: "members", label: "Members", count: eventCounts.members },
                { id: "ops", label: "Ops", count: eventCounts.ops },
                {
                  id: "workspace",
                  label: "Workspace",
                  count: eventCounts.workspace,
                },
              ]}
            />
          </div>
          <EventsList
            events={filteredEvents}
            emptyAction={
              eventFilter !== "all" ? (
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                  onClick={() => setEventFilter("all")}
                >
                  Clear filter
                </button>
              ) : (
                <Link
                  href="/settings?mode=workspace"
                  className="ds-btn ds-btn-ghost ds-btn-sm"
                >
                  Settings overview
                </Link>
              )
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 flex-1 flex-col border-b border-[var(--line)] lg:border-b-0 lg:border-r">
            {rows.length === 0 ? (
              <EmptyState
                compact
                title="No packs"
                body="Try another agent or export a new pack."
                action={
                  agentId !== "all" ? (
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      onClick={() => onAgent("all")}
                    >
                      Show all agents
                    </button>
                  ) : (
                    <Link
                      href="/settings?mode=workspace"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                    >
                      Settings overview
                    </Link>
                  )
                }
              />
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {rows.map((p) => {
                  const active = p.id === selected?.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => onSelectPack(p.id)}
                        className={cn(
                          "flex w-full flex-col gap-1.5 border-b border-[var(--line)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] sm:px-6",
                          active && "bg-[var(--accent-muted)]",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <PackKindChip kind={p.kind} />
                          {p.kind === "verify" ? (
                            <VerifyChip verified={p.verified} />
                          ) : null}
                          <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                            {p.framework || "Evidence pack"}
                          </span>
                          <span className="type-meta">{p.at}</span>
                        </div>
                        <p className="type-meta">
                          {p.periodStart} – {p.periodEnd}
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
              <PackDetail pack={selected} />
            ) : (
              <EmptyState compact title="Select a pack" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EventsList({
  events,
  emptyAction,
}: {
  events: AuditEventFixture[];
  emptyAction?: React.ReactNode;
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        compact
        title="No audit events"
        body="Actions in Settings appear here."
        action={emptyAction}
      />
    );
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {events.map((e) => {
        const inner = (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="type-ui text-[var(--text)]">{e.action}</p>
              <span className="type-meta">{e.at}</span>
            </div>
            <p className="type-meta mt-1">
              {e.actor}
              <span className="mx-1.5 text-[var(--text-faint)]">·</span>
              {e.target}
            </p>
            {e.detail ? (
              <p className="type-body mt-1.5 text-[var(--text-secondary)]">
                {e.detail}
              </p>
            ) : null}
          </>
        );
        return (
          <li key={e.id} className="border-b border-[var(--line)]">
            {e.href ? (
              <Link
                href={e.href}
                className="block px-4 py-3 transition-colors hover:bg-[var(--bg-hover)] sm:px-6"
              >
                {inner}
              </Link>
            ) : (
              <div className="px-4 py-3 sm:px-6">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PackDetail({ pack }: { pack: AuditPackFixture }) {
  return (
    <div className="flex h-full flex-col border-t border-[var(--line)] bg-[var(--bg-inset)] px-4 py-4 sm:px-6 lg:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <PackKindChip kind={pack.kind} />
        {pack.kind === "verify" ? (
          <VerifyChip verified={pack.verified} />
        ) : null}
      </div>
      <h2 className="type-ui mt-3 text-[var(--text)]">
        {pack.framework || "Evidence pack"}
      </h2>
      <p className="type-meta mt-1">{pack.at}</p>
      <dl className="mt-4 space-y-3">
        <div>
          <dt className="type-label">Period</dt>
          <dd className="type-body mt-1 text-[var(--text-secondary)]">
            {pack.periodStart} – {pack.periodEnd}
          </dd>
        </div>
      </dl>
      {!pack.verified ? (
        <p className="type-body mt-4 text-[var(--error)]">
          Verify failed — re-verify, or inspect the agent&rsquo;s traces.
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <p className="type-meta w-full text-[var(--text-faint)]">
          Pack export and re-verify aren’t available yet.
        </p>
      </div>
    </div>
  );
}
