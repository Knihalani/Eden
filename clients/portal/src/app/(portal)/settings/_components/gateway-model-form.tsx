"use client";

import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";

export const PROVIDER_OPTIONS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "bedrock", label: "AWS Bedrock" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "local", label: "Local (OpenAI-compatible)" },
] as const;

export const EMPTY_GATEWAY_FORM = {
  name: "",
  provider: "openai",
  upstream_model: "",
  upstream_api_key: "",
  endpoint: "",
  routing_priority: 100,
};

export type GatewayFormState = typeof EMPTY_GATEWAY_FORM;

interface GatewayModelFormProps {
  editingName: string | null;
  form: GatewayFormState;
  setForm: (next: GatewayFormState) => void;
  showKey: boolean;
  setShowKey: (next: boolean) => void;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}

export function GatewayModelForm({
  editingName,
  form,
  setForm,
  showKey,
  setShowKey,
  saving,
  onCancel,
  onSubmit,
}: GatewayModelFormProps) {
  const editing = !!editingName;
  return (
    <div className="mt-4 space-y-4 border-t border-[var(--border-default)] pt-4">
      <h4 className="text-sm font-semibold">
        {editing ? `Edit ${editingName}` : "Register a new upstream model"}
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField
          label="Logical name"
          htmlFor="gw-name"
          description="The name callers use in API requests. Unique per workspace."
        >
          <input
            id="gw-name"
            type="text"
            value={form.name}
            disabled={editing}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="gpt-4o-mini"
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] disabled:opacity-50"
          />
        </FormField>
        <FormField label="Provider" htmlFor="gw-provider">
          <select
            id="gw-provider"
            value={form.provider}
            disabled={editing}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
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
            onChange={(e) => setForm({ ...form, upstream_model: e.target.value })}
            placeholder="gpt-4o-mini-2024-07-18"
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
          />
        </FormField>
        <FormField label="Endpoint (optional)" htmlFor="gw-endpoint">
          <input
            id="gw-endpoint"
            type="text"
            value={form.endpoint}
            onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
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
              onChange={(e) => setForm({ ...form, upstream_api_key: e.target.value })}
              placeholder={editing ? "Leave blank to keep current key" : "sk-..."}
              autoComplete="off"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] font-mono"
            />
          </FormField>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowKey(!showKey)}
            className="min-h-11 min-w-11 mb-0.5"
            aria-label={showKey ? "Hide API key" : "Show API key"}
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </Button>
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
              setForm({ ...form, routing_priority: Number(e.target.value) || 0 })
            }
            className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]"
          />
        </FormField>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          className="min-h-11"
          onClick={onSubmit}
          disabled={
            !form.name.trim() ||
            !form.upstream_model.trim() ||
            (!editing && !form.upstream_api_key)
          }
          loading={saving}
        >
          {editing ? "Save changes" : "Register model"}
        </Button>
      </div>
    </div>
  );
}
