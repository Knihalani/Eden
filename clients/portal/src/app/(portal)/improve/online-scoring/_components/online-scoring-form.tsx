"use client";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";

export function OnlineScoringForm({
  editingId,
  name,
  filterQuery,
  scorerType,
  sampleRate,
  busy,
  onName,
  onFilter,
  onType,
  onRate,
  onSave,
  onCancel,
}: {
  editingId: string | null;
  name: string;
  filterQuery: string;
  scorerType: string;
  sampleRate: number;
  busy: boolean;
  onName: (v: string) => void;
  onFilter: (v: string) => void;
  onType: (v: string) => void;
  onRate: (v: number) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <Panel
      tone="flat"
      padding="md"
      className="space-y-3"
      data-testid="online-scoring-form"
    >
      <h3 className="text-sm font-medium">
        {editingId ? "Edit rule" : "Create rule"}
      </h3>
      <FormField label="Name" htmlFor="os-name" required>
        <Input id="os-name" value={name} onChange={(e) => onName(e.target.value)} />
      </FormField>
      <FormField label="Filter query" htmlFor="os-filter">
        <Input
          id="os-filter"
          value={filterQuery}
          onChange={(e) => onFilter(e.target.value)}
          placeholder='agent="…" outcome=failure'
        />
      </FormField>
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Scorer type" htmlFor="os-type">
          <select
            id="os-type"
            className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2 text-sm"
            value={scorerType}
            onChange={(e) => onType(e.target.value)}
          >
            <option value="code">code</option>
            <option value="slm">slm</option>
            <option value="llm">llm</option>
          </select>
        </FormField>
        <FormField label="Sample rate (0–1)" htmlFor="os-rate">
          <Input
            id="os-rate"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={sampleRate}
            onChange={(e) => onRate(Number(e.target.value))}
          />
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button
          className="min-h-11"
          onClick={onSave}
          disabled={busy || !name.trim()}
          loading={busy}
        >
          Save
        </Button>
        <Button variant="ghost" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}
