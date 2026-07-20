"use client";

import { useState } from "react";
import { Plus, Trash2, Server, Eye, EyeOff, RefreshCw } from "lucide-react";
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
import { FormField } from "@/components/ui/form-field";
import { errorFromCaught } from "@/lib/safe-error-message";
import { IntegrationStatusBanners } from "@/components/integration-status-banners";
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
  org: {
    id: string;
    role: string;
  } | null;
}
const PROVIDER_OPTIONS = [{
  id: "openai",
  label: "OpenAI"
}, {
  id: "anthropic",
  label: "Anthropic"
}, {
  id: "bedrock",
  label: "AWS Bedrock"
}, {
  id: "openrouter",
  label: "OpenRouter"
}, {
  id: "local",
  label: "Local (OpenAI-compatible)"
}];
const EMPTY_FORM = {
  name: "",
  provider: "openai",
  upstream_model: "",
  upstream_api_key: "",
  endpoint: "",
  routing_priority: 100
};
export function GatewayTab({
  org
}: GatewayTabProps) {
  const toast = useToast();
  const {
    confirm,
    ConfirmDialog
  } = useConfirm();
  const { role: resolvedRole } = usePermissions();
  const orgId = org?.id ?? null;
  const {
    data: models = [],
    isLoading: loading,
    error: modelsError,
    refetch,
  } = useOrgQuery(
    queryKeys.gateway.models(orgId),
    orgId,
    () => api.listGatewayModels(orgId!),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<GatewayModel | null>(null);
  const [form, setForm] = useState({
    ...EMPTY_FORM
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage =
    isAdminOrOwner(resolvedRole) || isAdminOrOwner(org?.role);
  const loadModels = () => refetch();
  const loadError = modelsError
    ? errorFromCaught(modelsError, "Failed to load gateway models")
    : null;
  const startCreate = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM
    });
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
      routing_priority: m.routing_priority
    });
    setShowKey(false);
    setShowCreate(true);
  };
  const cancelForm = () => {
    setShowCreate(false);
    setEditing(null);
    setForm({
      ...EMPTY_FORM
    });
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
          routing_priority: form.routing_priority
        };
        // Only send the key if the user typed one
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
          routing_priority: form.routing_priority
        });
        toast.success("Model registered");
      }
      cancelForm();
      await loadModels();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save model";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };
  const handleToggleEnabled = async (m: GatewayModel) => {
    if (!org) return;
    try {
      await api.updateGatewayModel(org.id, m.model_id, {
        enabled: !m.enabled
      });
      await loadModels();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update model";
      toast.error(message);
    }
  };
  const handleDelete = async (m: GatewayModel) => {
    if (!org) return;
    if (!(await confirm({
      title: "Delete gateway model",
      description: `Delete '${m.name}'? The gateway will no longer route requests to ${m.provider}.`,
      confirmLabel: "Delete",
      variant: "destructive"
    }))) {
      return;
    }
    try {
      await api.deleteGatewayModel(org.id, m.model_id);
      await loadModels();
      toast.success("Model deleted");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete model";
      toast.error(message);
    }
  };
  if (!org) {
    return <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to manage AI Gateway models.
      </div>;
  }
  const columns: DataTableColumn<GatewayModel>[] = [{
    key: "name",
    header: "Name",
    sortable: true,
    sticky: true,
    cell: m => <span className="font-medium text-[var(--text-primary)]">{m.name}</span>
  }, {
    key: "provider",
    header: "Provider",
    sortable: true,
    cell: m => <span className="px-2 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded text-xs">
          {m.provider}
        </span>
  }, {
    key: "upstream_model",
    header: "Upstream model",
    sortable: true,
    cell: m => <span className="text-sm text-[var(--text-secondary)] font-mono">{m.upstream_model}</span>
  }, {
    key: "upstream_key_prefix",
    header: "Key",
    cell: m => <code className="text-sm text-[var(--text-muted)] font-mono">
          {m.upstream_key_prefix ? `...${m.upstream_key_prefix}` : "—"}
        </code>
  }, {
    key: "routing_priority",
    header: "Priority",
    sortable: true,
    align: "right",
    cell: m => <span className="text-sm text-[var(--text-muted)]">{m.routing_priority}</span>
  }, {
    key: "enabled",
    header: "Status",
    sortable: true,
    cell: m => {
      const cls = cn("px-2 py-0.5 rounded text-xs font-medium", m.enabled ? "bg-[var(--terminal-faint)] text-[var(--terminal)]" : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]");
      return canManage ? <button onClick={() => handleToggleEnabled(m)} className={cls}>
            {m.enabled ? "Enabled" : "Disabled"}
          </button> : <span className={cls}>{m.enabled ? "Enabled" : "Disabled"}</span>;
    }
  }, {
    key: "model_id",
    header: "",
    align: "right",
    cell: m => canManage ? <div className="flex items-center gap-1 justify-end">
            <button onClick={() => startEdit(m)} className="px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-tertiary)] rounded">
              Edit
            </button>
            <button onClick={() => handleDelete(m)} className="p-1.5 text-[var(--error)] hover:bg-[var(--error-dim)] rounded-lg" title="Delete" aria-label={`Delete ${m.name}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div> : null
  }];
  return <div className="space-y-space-4">
      <IntegrationStatusBanners integration="gateway" orgId={org.id} />

      <Card padding="md">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">
              Upstream models
            </h3>
            <p className="text-xs text-[var(--text-muted)] max-w-2xl">
              Register the upstream providers your OpenAI-compatible
              requests should be routed to. Upstream API keys are
              encrypted at rest — only the last 4 characters are shown
              back to the portal.
            </p>
          </div>
          {canManage && !showCreate && (
            <Button variant="default" className="min-h-11 flex-shrink-0" onClick={startCreate}>
              <Plus className="w-4 h-4" />
              Add model
            </Button>
          )}
        </div>

        {showCreate && <div className="mt-4 space-y-4 border-t border-[var(--border-default)] pt-4">
            <h4 className="text-sm font-semibold">
              {editing ? `Edit ${editing.name}` : "Register a new upstream model"}
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField
                label="Logical name"
                htmlFor="gw-name"
                description="The name callers use in API requests. Unique per org."
              >
                <input
                  id="gw-name"
                  type="text"
                  value={form.name}
                  disabled={!!editing}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      name: e.target.value,
                    })
                  }
                  placeholder="gpt-4o-mini"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] disabled:opacity-50"
                />
              </FormField>
              <FormField label="Provider" htmlFor="gw-provider">
                <select
                  id="gw-provider"
                  value={form.provider}
                  disabled={!!editing}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      provider: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] disabled:opacity-50"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Upstream model id" htmlFor="gw-upstream-model">
                <input
                  id="gw-upstream-model"
                  type="text"
                  value={form.upstream_model}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      upstream_model: e.target.value,
                    })
                  }
                  placeholder="gpt-4o-mini-2024-07-18"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                />
              </FormField>
              <FormField label="Endpoint (optional)" htmlFor="gw-endpoint">
                <input
                  id="gw-endpoint"
                  type="text"
                  value={form.endpoint}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      endpoint: e.target.value,
                    })
                  }
                  placeholder={
                    form.provider === "openai" ? "https://api.openai.com/v1" : "https://..."
                  }
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                />
              </FormField>
              <div className="sm:col-span-2 flex items-end gap-2">
                <FormField label="Upstream API key" htmlFor="gw-key" className="flex-1">
                  <input
                    id="gw-key"
                    type={showKey ? "text" : "password"}
                    value={form.upstream_api_key}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        upstream_api_key: e.target.value,
                      })
                    }
                    placeholder={editing ? "Leave blank to keep current key" : "sk-..."}
                    autoComplete="off"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] font-mono"
                  />
                </FormField>
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="min-h-11 min-w-11 p-2 hover:bg-[var(--bg-tertiary)] rounded-lg mb-0.5"
                  title={showKey ? "Hide key" : "Show key"}
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <FormField
                label="Routing priority"
                htmlFor="gw-priority"
                description="Lower numbers win when multiple rows share a name."
              >
                <input
                  id="gw-priority"
                  type="number"
                  min={0}
                  max={100000}
                  value={form.routing_priority}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      routing_priority: Number(e.target.value) || 0,
                    })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
                />
              </FormField>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={cancelForm} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Cancel
              </button>
              <Button
                variant="default"
                className="min-h-11"
                onClick={handleSubmit}
                disabled={!form.name.trim() || !form.upstream_model.trim() || (!editing && !form.upstream_api_key)}
                loading={saving}
              >
                {editing ? "Save changes" : "Register model"}
              </Button>
            </div>
          </div>}
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
            <button onClick={loadModels} disabled={loading} className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50" title="Refresh">
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
          <DataTable columns={columns} rows={models} rowKey={m => m.model_id} loading={loading} defaultSort={{
          key: "name",
          direction: "asc"
        }} emptyTitle="No upstream models yet" emptyDescription={canManage ? "Register an upstream provider to start routing traffic." : "An owner or admin must register an upstream provider first."} emptyIcon={Server} pageSize={25} />
        </Card>
      )}
      {ConfirmDialog}
    </div>;
}