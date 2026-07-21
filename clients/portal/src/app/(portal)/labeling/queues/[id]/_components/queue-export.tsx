"use client";

import { Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";

type Props = {
  datasetId: string;
  onDatasetIdChange: (value: string) => void;
  onPush: () => void;
  exporting: boolean;
};

export function QueueExport({ datasetId, onDatasetIdChange, onPush, exporting }: Props) {
  return (
    <div
      className="border border-[var(--border-subtle)] p-space-4"
      data-wave-e5-labeling="queue-push"
    >
      <h3 className="mb-2 text-sm font-medium">Push to dataset</h3>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Send done labels into a dataset. Leave the id blank to create one.
      </p>
      <FormField label="Dataset id (blank = create)" htmlFor="ds-export">
        <div className="flex flex-wrap gap-2">
          <Input
            id="ds-export"
            value={datasetId}
            onChange={(e) => onDatasetIdChange(e.target.value)}
            placeholder="dataset uuid"
            className="min-w-[12rem] flex-1"
          />
          <Button
            className="h-8 max-md:min-h-11"
            onClick={() => void onPush()}
            disabled={exporting}
            loading={exporting}
          >
            <Database className="h-3.5 w-3.5" />
            Push to dataset
          </Button>
        </div>
      </FormField>
    </div>
  );
}
