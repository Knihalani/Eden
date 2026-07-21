"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus } from "lucide-react";
import type { RefObject } from "react";

/** Create strip — primary Create + secondary name input (M13). */
export function DatasetsCreateStrip({
  nameInputRef,
  newName,
  setNewName,
  creating,
  createDataset,
}: {
  nameInputRef: RefObject<HTMLInputElement | null>;
  newName: string;
  setNewName: (v: string) => void;
  creating: boolean;
  createDataset: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Button
        className="h-8 max-md:min-h-11"
        onClick={createDataset}
        disabled={!newName.trim() || creating}
        loading={creating}
      >
        <Plus className="h-3.5 w-3.5" /> Create
      </Button>
      <Input
        ref={nameInputRef}
        placeholder="New dataset name"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        className="h-8 max-w-xs max-md:min-h-11"
        onKeyDown={(e) => {
          if (e.key === "Enter") void createDataset();
        }}
      />
    </div>
  );
}
