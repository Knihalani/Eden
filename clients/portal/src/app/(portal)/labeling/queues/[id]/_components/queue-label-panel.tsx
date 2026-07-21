"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import type { BoardItem } from "./use-labeling-queue";

type Props = {
  labels: string[];
  notes: string;
  onNotesChange: (value: string) => void;
  active: BoardItem | null;
  queue: BoardItem[];
  onApplyLabel: (label: string) => void;
  onSkip: () => void;
  onSelectItem: (id: string) => void;
};

export function QueueLabelPanel({
  labels,
  notes,
  onNotesChange,
  active,
  queue,
  onApplyLabel,
  onSkip,
  onSelectItem,
}: Props) {
  return (
    <div className="space-y-space-3 border border-[var(--border-subtle)] p-space-4">
      <h3 className="text-sm font-medium">Label</h3>
      <FormField label="Notes" htmlFor="label-notes">
        <Input
          id="label-notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Optional notes"
        />
      </FormField>
      <div className="flex flex-wrap gap-2">
        {labels.map((l, i) => (
          <Button
            key={l}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            className="h-8 max-md:min-h-11"
            disabled={!active}
            onClick={() => void onApplyLabel(l)}
          >
            <span className="mr-1 text-[var(--text-muted)]">{i + 1}</span>
            {l}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 max-md:min-h-11"
          disabled={!active}
          onClick={() => void onSkip()}
        >
          Skip (S)
        </Button>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-[var(--text-muted)]">Queue</h4>
        <ul className="max-h-40 space-y-1 overflow-auto text-xs">
          {queue.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`w-full truncate rounded px-2 py-1 text-left ${
                  item.id === active?.id
                    ? "bg-[var(--accent-muted)] text-[var(--accent)]"
                    : "hover:bg-[var(--surface-raised)]"
                }`}
                onClick={() => onSelectItem(item.id)}
              >
                {item.prompt || item.id}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
