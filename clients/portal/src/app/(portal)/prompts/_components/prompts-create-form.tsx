"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Textarea } from "@/components/ui/textarea";

export function PromptsCreateForm({
  name,
  description,
  autoEval,
  pending,
  onName,
  onDescription,
  onAutoEval,
  onCancel,
  onCreate,
}: {
  name: string;
  description: string;
  autoEval: boolean;
  pending: boolean;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onAutoEval: (v: boolean) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  return (
    <Panel tone="flat" padding="md" className="space-y-3" data-testid="prompts-create-form">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">New prompt entry</h2>
      <Input
        type="text"
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Prompt name (e.g. support_reply_v1)"
        className="bg-[var(--bg-inset)]"
      />
      <Textarea
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={2}
        className="bg-[var(--bg-inset)]"
      />
      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={autoEval}
          onChange={(e) => onAutoEval(e.target.checked)}
          className="h-4 w-4"
        />
        Auto-eval on every new version save
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onCreate} loading={pending}>
          Create
        </Button>
      </div>
    </Panel>
  );
}
