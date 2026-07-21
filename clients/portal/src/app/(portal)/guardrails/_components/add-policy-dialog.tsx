"use client";

import { useState, useEffect } from "react";
import { guardrailsApi } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  featureGatedMessage,
  FEATURE_NOT_ENABLED_MESSAGE,
  FEATURE_NOT_ENABLED_TITLE,
} from "@/lib/feature-flag-error";
import { ShieldCheck, AlertTriangle, Plus } from "lucide-react";

export function AddPolicyDialog({
  open,
  onOpenChange,
  orgId,
  onCreated
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("injection");
  const [action, setAction] = useState("block");
  const [configText, setConfigText] = useState("{}");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) {
      setName("");
      setKind("injection");
      setAction("block");
      setConfigText("{}");
      setError("");
    }
  }, [open]);
  async function handleSubmit() {
    setError("");
    let parsedSpec: Record<string, unknown> = {};
    try {
      parsedSpec = configText.trim() ? JSON.parse(configText) : {};
    } catch {
      setError("Spec must be valid JSON");
      return;
    }
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    try {
      await guardrailsApi.createPolicy(orgId, {
        name: name.trim(),
        kind,
        spec: parsedSpec,
        action,
      });
      toast.success("Policy created");
      onCreated();
    } catch (err) {
      const message = featureGatedMessage(err, "Failed to create policy");
      setError(message);
      toast.error(
        message === FEATURE_NOT_ENABLED_TITLE
          ? FEATURE_NOT_ENABLED_TITLE
          : "Couldn't create policy",
        message === FEATURE_NOT_ENABLED_TITLE
          ? FEATURE_NOT_ENABLED_MESSAGE
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[var(--accent)]" />
            Add guardrail policy
          </DialogTitle>
          <DialogDescription>
            Define a rule that gates content at the gateway. Spec is passed to the policy implementation; kind maps to the API type.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-space-4">
          <div>
            <label htmlFor="policy-name" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Name
            </label>
            <Input id="policy-name" value={name} onChange={e => setName(e.target.value)} placeholder="block-internal-domains" aria-label="Policy name" />
          </div>

          <div>
            <label htmlFor="policy-kind" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Kind
            </label>
            <select
              id="policy-kind"
              value={kind}
              onChange={e => {
                const next = e.target.value;
                setKind(next);
                setAction(next === "pii" ? "redact" : "block");
              }}
              aria-label="Policy kind"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
            >
              <option value="injection">Injection</option>
              <option value="pii">PII</option>
              <option value="hallucination">Hallucination</option>
              <option value="content">Content</option>
            </select>
          </div>

          <div>
            <label htmlFor="policy-action" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Action
            </label>
            <select
              id="policy-action"
              value={action}
              onChange={e => setAction(e.target.value)}
              aria-label="Policy action"
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
            >
              <option value="allow">Allow</option>
              <option value="warn">Warn</option>
              <option value="redact">Redact</option>
              <option value="block">Block</option>
              <option value="escalate">Escalate</option>
            </select>
          </div>

          <div>
            <label htmlFor="policy-spec" className="text-xs font-medium text-[var(--text-muted)] mb-space-1 block">
              Spec (JSON)
            </label>
            <Textarea id="policy-spec" value={configText} onChange={e => setConfigText(e.target.value)} placeholder='{"patterns": ["ssn", "email"]}' aria-label="Policy spec (JSON)" className="min-h-[100px] font-mono text-xs" />
          </div>

          {error && <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-3 py-2 rounded-lg flex items-center gap-2 border border-[var(--error)]/20">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {error}
            </div>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            aria-label="Cancel"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            className="min-h-11"
            onClick={handleSubmit}
            loading={submitting}
            aria-label="Create policy"
          >
            <Plus className="w-4 h-4" aria-hidden />
            Create policy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
}
