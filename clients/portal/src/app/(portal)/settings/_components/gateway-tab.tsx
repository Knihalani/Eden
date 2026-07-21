"use client";

import { useState } from "react";
import { Plus, Trash2, Server, RefreshCw } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { useOrgQuery } from "@/hooks/use-api-query";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { isAdminOrOwner } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
import {
  EMPTY_GATEWAY_FORM,
  GatewayModelForm,
  type GatewayFormState,
} from "./gateway-model-form";

/** Wave 7 — Advanced data plane (gateway / PII / retention / exports / DLQ). */
export const WS7_ADVANCED_DATA_COMPLETED = true as const;

interface GatewayModel {
  model_id: string;
  org_id: string;
  name: string;
  provider: string;
  upstream_model: string;
  upstream_key_prefix: string;
  endpoint: string | null;
  enabled: boolean;
  routing_priority: number;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface GatewayTabProps {
  org: { id: string; role: string } | null;
}

export function GatewayTab({ org }: GatewayTabProps) {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const { role: resolvedRole } = usePermissions();
  const orgId = org?.id ?? null;
  const {
    data: models = [],
    isLoading: loading,
    error: modelsError,
    refetch,
  } = useOrgQuery(queryKeys.gateway.models(orgId), orgId, () =>
    api.listGatewayModels(orgId!),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<GatewayModel | null>(null);
  const [form, setForm] = useState<GatewayFormState>({ ...EMPTY_GATEWAY_FORM });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage = isAdminOrOwner(resolvedRole) || isAdminOrOwner(org?.role);
  const loadModels = () => refetch();
  const loadError = modelsError
    ? errorFromCaught(modelsError, "Failed to load gateway models")
    : null;

  const startCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_GATEWAY_FORM });
    setShowKey(false);
    setShowCreate(true);
  };
  const startEdit = (m: GatewayModel) => {
    setEditing(m);
    setForm({
      name: m.name,
      provider: m.provider,
      upstream_model: m.upstream_model,
      upstream_api_key: "",
      endpoint: m.endpoint ?? "",
      routing_priority: m.routing_priority,
    });
    setShowKey(false);
    setShowCreate(true);
  };
  const cancelForm = () => {
    setShowCreate(false);
    setEditing(null);
    setForm({ ...EMPTY_GATEWAY_FORM });
    setShowKey(false);
  };

  const handleSubmit = async () => {
    if (!org) return;
    if (!form.name.trim() || !form.upstream_model.trim()) return;
    if (!editing && !form.upstream_api_key) return;
    setSaving(true);
    try {
      if (editing) {
        const payload: Parameters<typeof api.updateGatewayModel>[2] = {
          upstream_model: form.upstream_model,
          endpoint: form.endpoint || null,
          routing_priority: form.routing_priority,
        };
        if (form.upstream_api_key) {
          payload.upstream_api_key = form.upstream_api_key;
        }
        await api.updateGatewayModel(org.id, editing.model_id, payload);
        toast.success("Model updated");
      } else {
        await api.createGatewayModel(org.id, {
          name: form.name,
          provider: form.provider,
          upstream_model: form.upstream_model,
          upstream_api_key: form.upstream_api_key,
          endpoint: form.endpoint || null,
          routing_priority: form.routing_priority,
        });
        toast.success("Model registered");
      }
      cancelForm();
      await loadModels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save model");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (m: GatewayModel) => {
    if (!org) return;
    try {
      await api.updateGatewayModel(org.id, m.model_id, { enabled: !m.enabled });
      await loadModels();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update model");
    }
  };

  const handleDelete = async (m: GatewayModel) => {
    if (!org) return;
    if (
      !(await confirm({
        title: "Delete gateway model",
        description: `Delete '${m.name}'? The gateway will no longer route requests to ${m.provider}.`,
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    ) {
      return;
    }
    try {
      await api.deleteGatewayModel(org.id, m.model_id);
      await loadModels();
      toast.success("Model deleted");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete model");
    }
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]" data-ws7-gateway>
        Select a workspace to manage AI Gateway models.
      </div>
    );
  }

  const columns: DataTableColumn<GatewayModel>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      sticky: true,
      cell: (m) => <span className="font-medium text-[var(--text-primary)]">{m.name}</span>,
    },
    {
      key: "provider",
      header: "Provider",
      sortable: true,
      cell: (m) => (
        <span className="text-xs text-[var(--text-secondary)]">{m.provider}</span>
      ),
    },
    {
      key: "upstream_model",
      header: "Upstream model",
      sortable: true,
      cell: (m) => (
        <span className="text-sm text-[var(--text-secondary)] font-mono">{m.upstream_model}</span>
      ),
    },
    {
      key: "upstream_key_prefix",
      header: "Key",
      cell: (m) => (
        <code className="text-sm text-[var(--text-muted)] font-mono">
          {m.upstream_key_prefix ? `...${m.upstream_key_prefix}` : "—"}
        </code>
      ),
    },
    {
      key: "routing_priority",
      header: "Priority",
      sortable: true,
      align: "right",
      cell: (m) => (
        <span className="text-sm text-[var(--text-muted)]">{m.routing_priority}</span>
      ),
    },
    {
      key: "enabled",
      header: "Status",
      sortable: true,
      cell: (m) => {
        const label = m.enabled ? "Enabled" : "Disabled";
        return canManage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleToggleEnabled(m)}
            aria-label={`${label} — toggle`}
          >
            {label}
          </Button>
        ) : (
          <span className="text-xs text-[var(--text-muted)]">{label}</span>
        );
      },
    },
    {
      key: "model_id",
      header: "",
      align: "right",
      cell: (m) =>
        canManage ? (
          <div className="flex items-center gap-1 justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(m)}>
              Edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void handleDelete(m)}
              aria-label={`Delete ${m.name}`}
              className="text-[var(--error)] hover:bg-[var(--error-dim)]"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-space-4" data-ws7-gateway>
      <IntegrationStatusBanners integration="gateway" orgId={org.id} />

      <Card padding="md">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">
              Upstream models
            </h3>
            <p className="text-xs text-[var(--text-muted)] max-w-2xl">
              Register upstream providers for OpenAI-compatible routing. Keys are encrypted at
              rest — only the last 4 characters are shown.
            </p>
          </div>
          {canManage && !showCreate && (
            <Button
              type="button"
              variant="default"
              className="min-h-11 flex-shrink-0"
              onClick={startCreate}
            >
              <Plus className="w-4 h-4" />
              Add model
            </Button>
          )}
        </div>

        {showCreate && (
          <GatewayModelForm
            editingName={editing?.name ?? null}
            form={form}
            setForm={setForm}
            showKey={showKey}
            setShowKey={setShowKey}
            saving={saving}
            onCancel={cancelForm}
            onSubmit={() => void handleSubmit()}
          />
        )}
      </Card>

      {loadError ? (
        <ErrorState
          title="Could not load gateway models"
          message={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void loadModels()}>
              Try again
            </Button>
          }
        />
      ) : (
        <Card padding="lg" className="overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--border-default)]">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Registered models
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadModels()}
              disabled={loading}
              aria-label="Refresh models"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </Button>
          </div>
          <DataTable
            columns={columns}
            rows={models}
            rowKey={(m) => m.model_id}
            loading={loading}
            defaultSort={{ key: "name", direction: "asc" }}
            emptyTitle="No upstream models yet"
            emptyDescription={
              canManage
                ? "Register an upstream provider to start routing traffic."
                : "An owner or admin must register an upstream provider first."
            }
            emptyIcon={Server}
            pageSize={25}
          />
        </Card>
      )}
      {ConfirmDialog}
    </div>
  );
}
