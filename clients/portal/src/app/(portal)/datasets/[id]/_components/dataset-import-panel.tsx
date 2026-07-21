"use client";

import type { RefObject } from "react";

export function DatasetImportInput({
  fileRef,
  onImportFile,
}: {
  fileRef: RefObject<HTMLInputElement | null>;
  onImportFile: (file: File) => void;
}) {
  return (
    <input
      ref={fileRef}
      type="file"
      accept=".csv,.json,.jsonl,text/csv,application/json"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void onImportFile(f);
        e.target.value = "";
      }}
    />
  );
}

export function DatasetImportProgress({ progress }: { progress: string | null }) {
  if (!progress) return null;
  return <p className="mb-3 text-sm text-[var(--accent)]">{progress}</p>;
}
