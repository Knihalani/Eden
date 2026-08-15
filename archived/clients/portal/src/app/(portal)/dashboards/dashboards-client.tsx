"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutDashboard, Plus } from "lucide-react";
import { PageHeader } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import {
  QueryErrorPanel,
  QueryLoadingPanel,
} from "@/components/shell/query-error-panel";
import { wave6Api, type DashboardRow } from "@/lib/api/resources";
import { queryKeys } from "@/lib/query-keys";

function CreateDashboardDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useOrgMutation(
    async (body: { name: string }) => {
      const res = await wave6Api.createDashboard(orgId, { name: body.name });
      return res;
    },
    {
      invalidateKeys: [queryKeys.dashboards.list(orgId)],
      onSuccess: (data) => {
        const dash = (data as { data?: { dashboard?: { id: string } } })?.data?.dashboard;
        if (dash?.id) {
          onCreated(dash.id);
        } else {
          onClose();
        }
      },
      onError: (err) => {
        setError(err.message ?? "Failed to create dashboard");
      },
    },
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create dashboard"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm border border-[var(--line)] bg-[var(--bg)] p-6 shadow-lg">
        <h2 className="type-ui mb-4 text-[var(--text)]">New dashboard</h2>
        <label className="type-meta mb-1.5 block text-[var(--text-secondary)]">
          Name
        </label>
        <input
          className="ds-input mb-4 w-full"
          autoFocus
          placeholder="My dashboard"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              mutation.mutate({ name: name.trim() });
            }
            if (e.key === "Escape") onClose();
          }}
        />
        {error ? (
          <p className="type-meta mb-3 text-[var(--error)]">{error}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={!name.trim() || mutation.isPending}
            onClick={() => mutation.mutate({ name: name.trim() })}
          >
            {mutation.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardCard({ dash }: { dash: DashboardRow }) {
  return (
    <Link
      href={`/dashboards/${dash.id}`}
      className="group flex min-h-[6rem] flex-col gap-1.5 border border-[var(--line)] bg-[var(--bg)] p-5 transition-colors hover:bg-[var(--accent-muted)]"
    >
      <div className="flex items-center gap-2">
        <LayoutDashboard className="h-4 w-4 shrink-0 text-[var(--text-faint)]" aria-hidden />
        <span className="type-ui min-w-0 truncate text-[var(--text)]">
          {dash.name}
        </span>
        {dash.is_home ? (
          <span className="ds-chip ml-auto shrink-0 text-[var(--text-muted)]">
            Home
          </span>
        ) : null}
      </div>
      <p className="type-meta text-[var(--text-tertiary)]">
        Updated {new Date(dash.updated_at).toLocaleDateString()}
      </p>
    </Link>
  );
}

export default function DashboardsClient() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;

  const [showCreate, setShowCreate] = useState(false);

  const dashboardsQuery = useOrgQuery(
    queryKeys.dashboards.list(orgId),
    orgId,
    () => wave6Api.listDashboards(orgId!),
  );

  const dashboards: DashboardRow[] =
    (dashboardsQuery.data as { data?: { dashboards?: DashboardRow[] } })?.data?.dashboards ?? [];

  return (
    <div className="ds-page overflow-y-auto">
      <PageHeader
        title="Dashboards"
        actions={
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New dashboard
          </button>
        }
      />

      {dashboardsQuery.isLoading ? (
        <QueryLoadingPanel label="Loading dashboards…" />
      ) : dashboardsQuery.isError ? (
        <QueryErrorPanel
          error={dashboardsQuery.error}
          onRetry={() => dashboardsQuery.refetch()}
        />
      ) : dashboards.length === 0 ? (
        <div className="flex flex-col items-center gap-4 px-5 py-16 text-center">
          <LayoutDashboard className="h-8 w-8 text-[var(--text-faint)]" aria-hidden />
          <p className="type-body text-[var(--text-secondary)]">
            No dashboards yet. Create one to start building custom metric views.
          </p>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => setShowCreate(true)}
          >
            New dashboard
          </button>
        </div>
      ) : (
        <div className="grid gap-px border-t border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((dash) => (
            <DashboardCard key={dash.id} dash={dash} />
          ))}
        </div>
      )}

      {showCreate && orgId ? (
        <CreateDashboardDialog
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            window.location.href = `/dashboards/${id}`;
          }}
        />
      ) : null}
    </div>
  );
}
